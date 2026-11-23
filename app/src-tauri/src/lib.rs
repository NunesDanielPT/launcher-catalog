//! ShowKit — launcher das apps de Daniel Nunes.
//!
//! Fluxo: lê o catálogo (apps.json no GitHub) → para cada app pergunta à API do
//! GitHub qual é a última release → vê no registo do Windows o que está
//! instalado → descarrega e corre o instalador em modo silencioso.

use base64::Engine;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

/// Base do repositório do catálogo (apps.json + ícones).
const REPO_RAW: &str = "https://raw.githubusercontent.com/NunesDanielPT/launcher-catalog/main/";
/// Catálogo pela API do GitHub (sem a cache de 5 min do raw.githubusercontent.com).
const CATALOG_API: &str = "https://api.github.com/repos/NunesDanielPT/launcher-catalog/contents/apps.json?ref=main";
/// Quanto tempo uma resposta da API do GitHub fica em cache (limite: 60 pedidos/hora sem login).
const RELEASE_CACHE_SECS: u64 = 600;
/// Mesmo ao carregar em atualizar, uma resposta com menos disto é reutilizada.
const FORCE_MIN_SECS: u64 = 300;
/// Ícones guardados em cache durante um dia.
const ICON_CACHE_SECS: u64 = 86_400;

// ---------------------------------------------------------------- utilitários

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("ShowKit/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("net:{e}"))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Nome de ficheiro seguro (só letras, números, ponto, hífen e underscore).
fn safe_name(s: &str) -> String {
    let n: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' })
        .collect();
    if n.is_empty() || n.chars().all(|c| c == '.') {
        "file".into()
    } else {
        n
    }
}

async fn fetch_json(url: &str) -> Result<Value, String> {
    fetch_json_accept(url, "application/vnd.github+json").await
}

async fn fetch_json_accept(url: &str, accept: &str) -> Result<Value, String> {
    let r = http()?
        .get(url)
        .header("Accept", accept)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("net:{e}"))?;
    let status = r.status();
    if !status.is_success() {
        if status.as_u16() == 403 || status.as_u16() == 429 {
            return Err("ratelimit".into());
        }
        return Err(format!("http:{}", status.as_u16()));
    }
    r.json::<Value>().await.map_err(|e| format!("json:{e}"))
}

fn is_allowed_download(url: &str) -> bool {
    (url.starts_with("https://github.com/") && url.contains("/releases/download/"))
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/")
}

// ---------------------------------------------------------------- catálogo

#[derive(Serialize)]
struct CatalogResult {
    catalog: Value,
    offline: bool,
    fetched_at: u64,
}

#[tauri::command]
async fn get_catalog(app: AppHandle) -> Result<CatalogResult, String> {
    // Para testar um catálogo local: SHOWKIT_CATALOG=C:\caminho\apps.json
    if let Ok(p) = std::env::var("SHOWKIT_CATALOG") {
        let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        let catalog = serde_json::from_str(&txt).map_err(|e| format!("json:{e}"))?;
        return Ok(CatalogResult { catalog, offline: false, fetched_at: now() });
    }

    let cache = data_dir(&app)?.join("catalog.json");
    // Primeiro pela API do GitHub (atualizada logo após cada push); o raw.githubusercontent.com
    // tem cache de 5 minutos e fica como alternativa se a API falhar (ex.: limite de pedidos).
    let fresh = match fetch_json_accept(CATALOG_API, "application/vnd.github.raw+json").await {
        Ok(v) => Ok(v),
        Err(_) => fetch_json(&format!("{REPO_RAW}apps.json")).await,
    };
    match fresh {
        Ok(catalog) => {
            let _ = std::fs::write(&cache, json!({ "at": now(), "catalog": catalog }).to_string());
            Ok(CatalogResult { catalog, offline: false, fetched_at: now() })
        }
        Err(e) => {
            let saved: Value = std::fs::read_to_string(&cache)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .ok_or_else(|| format!("nocatalog:{e}"))?;
            Ok(CatalogResult {
                catalog: saved["catalog"].clone(),
                offline: true,
                fetched_at: saved["at"].as_u64().unwrap_or(0),
            })
        }
    }
}

/// Devolve o ícone como data URL (funciona offline depois da primeira vez).
#[tauri::command]
async fn get_icon(app: AppHandle, path: String) -> Result<String, String> {
    let url = if path.starts_with("https://") { path.clone() } else { format!("{REPO_RAW}{path}") };
    let dir = data_dir(&app)?.join("icons");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(safe_name(&path));

    let fresh = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age.as_secs() < ICON_CACHE_SECS)
        .unwrap_or(false);

    let bytes = if fresh {
        std::fs::read(&file).map_err(|e| e.to_string())?
    } else {
        let fetched = async {
            let r = http()?.get(&url).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
            if !r.status().is_success() {
                return Err(format!("http:{}", r.status().as_u16()));
            }
            r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
        }
        .await;
        match fetched {
            Ok(b) => {
                let _ = std::fs::write(&file, &b);
                b
            }
            Err(e) => std::fs::read(&file).map_err(|_| e)?,
        }
    };

    let mime = if path.to_lowercase().ends_with(".svg") { "image/svg+xml" } else { "image/png" };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// ---------------------------------------------------------------- releases

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct ReleaseInfo {
    version: String,
    tag: String,
    published_at: String,
    notes: String,
    html_url: String,
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size: u64,
    checked_at: u64,
    stale: bool,
    /// ETag da API do GitHub: um pedido com If-None-Match que responde 304 não gasta quota.
    #[serde(default)]
    etag: Option<String>,
    /// Padrão do instalador usado nesta resposta (se o catálogo mudar, a cache deixa de servir).
    #[serde(default)]
    pattern: String,
}

fn parse_release(v: &Value, asset_pattern: &str) -> Result<ReleaseInfo, String> {
    let re = Regex::new(asset_pattern).map_err(|e| format!("regex:{e}"))?;
    let tag = v["tag_name"].as_str().ok_or("json:tag_name")?.to_string();
    let asset = v["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().map(|n| re.is_match(n)).unwrap_or(false));
    Ok(ReleaseInfo {
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        tag,
        published_at: v["published_at"].as_str().unwrap_or_default().to_string(),
        notes: v["body"].as_str().unwrap_or_default().to_string(),
        html_url: v["html_url"].as_str().unwrap_or_default().to_string(),
        asset_name: asset.and_then(|a| a["name"].as_str()).map(String::from),
        asset_url: asset.and_then(|a| a["browser_download_url"].as_str()).map(String::from),
        asset_size: asset.and_then(|a| a["size"].as_u64()).unwrap_or(0),
        checked_at: now(),
        stale: false,
        etag: None,
        pattern: asset_pattern.to_string(),
    })
}

/// Resultado de um pedido à API com ETag.
enum ApiAnswer {
    Body(Value, Option<String>),
    NotModified,
    NotFound,
    /// Limite de pedidos, bloqueado ou sem resposta: tentar pelas páginas do github.com.
    Unavailable(String),
}

async fn api_release(repo: &str, etag: Option<&str>) -> ApiAnswer {
    let client = match http() {
        Ok(c) => c,
        Err(e) => return ApiAnswer::Unavailable(e),
    };
    let mut req = client
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20));
    if let Some(e) = etag {
        req = req.header("If-None-Match", e);
    }
    let r = match req.send().await {
        Ok(r) => r,
        Err(e) => return ApiAnswer::Unavailable(format!("net:{e}")),
    };
    match r.status().as_u16() {
        304 => ApiAnswer::NotModified,
        404 => ApiAnswer::NotFound,
        200 => {
            let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
            match r.json::<Value>().await {
                Ok(v) => ApiAnswer::Body(v, etag),
                Err(e) => ApiAnswer::Unavailable(format!("json:{e}")),
            }
        }
        403 | 429 => ApiAnswer::Unavailable("ratelimit".into()),
        c => ApiAnswer::Unavailable(format!("http:{c}")),
    }
}

/// Tag para onde o github.com/<repo>/releases/latest redireciona (sem gastar quota da API).
/// Ok(None) = o repositório ainda não tem releases.
async fn pages_latest_tag(repo: &str) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("ShowKit/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("net:{e}"))?;
    let r = client
        .get(format!("https://github.com/{repo}/releases/latest"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("net:{e}"))?;
    if r.status().as_u16() == 404 {
        return Ok(None);
    }
    let loc = r
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("http:{}", r.status().as_u16()))?
        .to_string();
    Ok(tag_from_location(&loc, repo))
}

fn tag_from_location(loc: &str, repo: &str) -> Option<String> {
    let prefix = format!("https://github.com/{}/releases/tag/", repo).to_lowercase();
    if loc.to_lowercase().starts_with(&prefix) {
        let tag = &loc[prefix.len()..];
        (!tag.is_empty()).then(|| tag.to_string())
    } else {
        None
    }
}

/// Nomes dos ficheiros de uma release, lidos da página expanded_assets do github.com.
fn asset_names_from_html(html: &str, repo: &str, tag: &str) -> Vec<String> {
    let re = Regex::new(&format!(
        r#"(?i)href="/{}/releases/download/{}/([^"?#]+)""#,
        regex::escape(repo),
        regex::escape(tag)
    ))
    .expect("regex");
    let mut out: Vec<String> = re.captures_iter(html).map(|c| c[1].replace("%20", " ")).collect();
    out.dedup();
    out
}

async fn pages_release(repo: &str, asset_pattern: &str, cached: Option<&ReleaseInfo>) -> Result<ReleaseInfo, String> {
    let tag = pages_latest_tag(repo).await?.ok_or("http:404")?;
    if let Some(c) = cached.filter(|c| c.tag == tag && c.pattern == asset_pattern && c.asset_url.is_some()) {
        let mut c = c.clone();
        c.checked_at = now();
        c.stale = false;
        return Ok(c);
    }
    let html = http()?
        .get(format!("https://github.com/{repo}/releases/expanded_assets/{tag}"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("net:{e}"))?
        .text()
        .await
        .map_err(|e| format!("net:{e}"))?;
    let re = Regex::new(asset_pattern).map_err(|e| format!("regex:{e}"))?;
    let name = asset_names_from_html(&html, repo, &tag).into_iter().find(|n| re.is_match(n));
    Ok(ReleaseInfo {
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        html_url: format!("https://github.com/{repo}/releases/tag/{tag}"),
        asset_url: name.as_ref().map(|n| format!("https://github.com/{repo}/releases/download/{tag}/{n}")),
        asset_name: name,
        asset_size: 0,
        published_at: String::new(),
        notes: String::new(),
        tag,
        checked_at: now(),
        stale: false,
        etag: None,
        pattern: asset_pattern.to_string(),
    })
}

#[tauri::command]
async fn get_release(app: AppHandle, repo: String, asset: String, force: bool) -> Result<ReleaseInfo, String> {
    let dir = data_dir(&app)?.join("releases");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", safe_name(&repo)));
    let cached: Option<ReleaseInfo> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok());

    let cached = cached.filter(|c| c.pattern == asset);
    if let Some(c) = &cached {
        let age = now().saturating_sub(c.checked_at);
        if age < FORCE_MIN_SECS || (!force && age < RELEASE_CACHE_SECS) {
            return Ok(c.clone());
        }
    }
    let save = |info: &ReleaseInfo| {
        let _ = std::fs::write(&file, serde_json::to_string(info).unwrap_or_default());
    };

    // 1) API do GitHub, com ETag (resposta 304 não conta para o limite de 60/hora).
    let api_err = match api_release(&repo, cached.as_ref().and_then(|c| c.etag.as_deref())).await {
        ApiAnswer::NotModified if cached.is_some() => {
            let mut c = cached.clone().expect("cache");
            c.checked_at = now();
            c.stale = false;
            save(&c);
            return Ok(c);
        }
        ApiAnswer::Body(v, etag) => match parse_release(&v, &asset) {
            Ok(mut info) => {
                info.etag = etag;
                save(&info);
                return Ok(info);
            }
            Err(e) => e,
        },
        ApiAnswer::NotFound => {
            // Sem releases publicadas (ou só pré-releases).
            let _ = std::fs::remove_file(&file);
            return Err("http:404".into());
        }
        ApiAnswer::NotModified => "http:304".into(),
        ApiAnswer::Unavailable(e) => e,
    };

    // 2) Páginas do github.com: não gastam quota e funcionam quando a API está bloqueada.
    match pages_release(&repo, &asset, cached.as_ref()).await {
        Ok(info) => {
            save(&info);
            Ok(info)
        }
        Err(e) if e == "http:404" => Err(e),
        Err(_) => match cached {
            Some(mut c) => {
                c.stale = true;
                Ok(c)
            }
            None => Err(api_err),
        },
    }
}

// ---------------------------------------------------------------- o que está instalado

#[derive(Deserialize, Debug, Default, Clone)]
struct Detect {
    #[serde(rename = "registryKey")]
    registry_key: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "altNames", default)]
    alt_names: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct DetectSpec {
    id: String,
    #[serde(default)]
    detect: Detect,
    exe: Option<String>,
    /// Pastas onde procurar o exe quando o registo não diz onde está (aceita %VARIAVEIS%).
    #[serde(rename = "exeSearch", default)]
    exe_search: Vec<String>,
}

/// Uma entrada de "Programas e Funcionalidades" (chave Uninstall do registo).
#[derive(Deserialize, Debug, Default, Clone)]
struct UninstallEntry {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
    version: Option<String>,
    location: Option<String>,
    icon: Option<String>,
    uninstall: Option<String>,
    quiet: Option<String>,
}

#[derive(Serialize, Debug)]
struct Installed {
    version: String,
    location: Option<String>,
    exe: Option<String>,
    uninstall: Option<String>,
    quiet: Option<String>,
}

fn find_entry<'a>(spec: &DetectSpec, entries: &'a [UninstallEntry]) -> Option<&'a UninstallEntry> {
    if let Some(k) = &spec.detect.registry_key {
        if let Some(e) = entries.iter().find(|e| e.key.eq_ignore_ascii_case(k)) {
            return Some(e);
        }
    }
    let names: Vec<String> = spec
        .detect
        .display_name
        .iter()
        .chain(spec.detect.alt_names.iter())
        .map(|n| n.to_lowercase())
        .collect();
    names.iter().find_map(|wanted| {
        entries.iter().find(|e| {
            let n = e.name.to_lowercase();
            // "MapSim" apanha "MapSim 0.54.0" mas não "MapSimulator".
            n == *wanted || n.starts_with(&format!("{wanted} "))
        })
    })
}

/// Caminho do executável a partir de "DisplayIcon" (ex.: "C:\...\App.exe,0").
fn exe_from_icon(icon: &str) -> Option<String> {
    let s = icon.trim().trim_matches('"');
    let s = match s.rfind(',') {
        Some(i) if s[i + 1..].trim().parse::<i32>().is_ok() => &s[..i],
        _ => s,
    };
    let s = s.trim().trim_matches('"');
    s.to_lowercase().ends_with(".exe").then(|| s.to_string())
}

fn resolve_exe(spec: &DetectSpec, e: &UninstallEntry) -> Option<String> {
    let loc = e.location.as_deref().map(|l| l.trim().trim_matches('"')).filter(|l| !l.is_empty());
    if let (Some(loc), Some(exe)) = (loc, &spec.exe) {
        let p = Path::new(loc).join(exe);
        if p.exists() || cfg!(not(windows)) {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    if let Some(from_icon) = e.icon.as_deref().and_then(exe_from_icon) {
        let lower = from_icon.to_lowercase();
        // Evita abrir o desinstalador (ou o msiexec) por engano.
        if !lower.contains("unins") && !lower.contains("uninstall") && !lower.contains("msiexec") && Path::new(&from_icon).exists() {
            return Some(from_icon);
        }
    }
    let exe = spec.exe.as_ref()?;
    spec.exe_search
        .iter()
        .map(|d| Path::new(&expand_env(d)).join(exe))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Troca %VARIAVEL% pelo valor da variável de ambiente.
fn expand_env(s: &str) -> String {
    let re = Regex::new(r"%([A-Za-z0-9_()]+)%").expect("regex");
    re.replace_all(s, |c: &regex::Captures| std::env::var(&c[1]).unwrap_or_else(|_| c[0].to_string())).into_owned()
}

fn msiexec() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\msiexec.exe")
}

/// Código de produto MSI ({GUID}) dentro de "MsiExec.exe /X{...}".
fn msi_product_code(s: &str) -> Option<String> {
    let re = Regex::new(r"\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}").expect("regex");
    re.find(s).map(|m| m.as_str().to_string())
}

/// Lista as entradas Uninstall (utilizador + máquina, 64 e 32 bits) via PowerShell.
fn read_uninstall_entries() -> Result<Vec<UninstallEntry>, String> {
    if !cfg!(windows) {
        return Ok(vec![]);
    }
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
         'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
         'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$r = foreach ($p in $paths) {
  Get-ItemProperty $p | Where-Object { $_.DisplayName } | ForEach-Object {
    [pscustomobject]@{
      key = [string]$_.PSChildName; name = [string]$_.DisplayName; version = [string]$_.DisplayVersion
      location = [string]$_.InstallLocation; icon = [string]$_.DisplayIcon
      uninstall = [string]$_.UninstallString; quiet = [string]$_.QuietUninstallString
    }
  }
}
ConvertTo-Json -InputObject @($r) -Compress
"#;
    let out = ps_command(script).output().map_err(|e| format!("ps:{e}"))?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let txt = txt.trim().trim_start_matches('\u{feff}');
    if txt.is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(txt).map_err(|e| format!("json:{e}"))
}

#[tauri::command]
async fn get_installed(specs: Vec<DetectSpec>) -> Result<HashMap<String, Installed>, String> {
    let entries = tokio::task::spawn_blocking(read_uninstall_entries)
        .await
        .map_err(|e| e.to_string())??;
    let mut map = HashMap::new();
    for spec in &specs {
        if let Some(e) = find_entry(spec, &entries) {
            let blank = |s: &Option<String>| s.clone().filter(|v| !v.trim().is_empty());
            map.insert(
                spec.id.clone(),
                Installed {
                    version: e.version.clone().unwrap_or_default(),
                    location: blank(&e.location),
                    exe: resolve_exe(spec, e),
                    uninstall: blank(&e.uninstall),
                    quiet: blank(&e.quiet),
                },
            );
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------- processos

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ps_command(script: &str) -> Command {
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Script que corre um programa (com UAC se o instalador o pedir), espera e devolve o código de saída.
/// 1223 = o utilizador recusou o pedido de administrador.
fn start_process_script(exe: &str, args: &[String]) -> String {
    let args: Vec<String> = args.iter().filter(|a| !a.trim().is_empty()).map(|a| ps_quote(a)).collect();
    let arglist = if args.is_empty() { String::new() } else { format!(" -ArgumentList {}", args.join(",")) };
    format!(
        "$ErrorActionPreference='Stop'; try {{ $p = Start-Process -FilePath {}{} -Wait -PassThru; exit $p.ExitCode }} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }}",
        ps_quote(exe),
        arglist
    )
}

async fn run_and_wait(exe: String, args: Vec<String>) -> Result<(), String> {
    let script = start_process_script(&exe, &args);
    let code = tokio::task::spawn_blocking(move || ps_command(&script).output().map(|o| o.status.code().unwrap_or(-1)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("ps:{e}"))?;
    match code {
        0 | 3010 | 1641 => Ok(()),
        1223 | 1602 => Err("cancelled".into()),
        c => Err(format!("exit:{c}")),
    }
}

/// Separa "\"C:\Program Files\X\unins000.exe\" /S" em (exe, resto).
fn split_cmdline(s: &str) -> (String, String) {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
        return (rest.to_string(), String::new());
    }
    if let Some(i) = s.to_lowercase().find(".exe") {
        let cut = i + 4;
        return (s[..cut].to_string(), s[cut..].trim().to_string());
    }
    match s.split_once(' ') {
        Some((a, b)) => (a.to_string(), b.trim().to_string()),
        None => (s.to_string(), String::new()),
    }
}

// ---------------------------------------------------------------- download

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    phase: &'static str,
    received: u64,
    total: u64,
}

fn emit(app: &AppHandle, id: &str, phase: &'static str, received: u64, total: u64) {
    let _ = app.emit("showkit://progress", Progress { id: id.to_string(), phase, received, total });
}

async fn download(app: &AppHandle, id: &str, url: &str, file_name: &str, expected: u64) -> Result<PathBuf, String> {
    if !is_allowed_download(url) {
        return Err("badurl".into());
    }
    let dir = std::env::temp_dir().join("ShowKit");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(file_name));

    let resp = http()?.get(url).send().await.map_err(|e| format!("net:{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http:{}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(expected);
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received = 0u64;
    let mut last = Instant::now();
    emit(app, id, "download", 0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("net:{e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(120) {
            emit(app, id, "download", received, total);
            last = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    emit(app, id, "download", received, total);

    let want = if expected > 0 { expected } else { total };
    if want > 0 && received != want {
        let _ = std::fs::remove_file(&path);
        return Err("incomplete".into());
    }
    Ok(path)
}

// ---------------------------------------------------------------- ações

#[tauri::command]
async fn install_app(
    app: AppHandle,
    id: String,
    url: String,
    file_name: String,
    size: u64,
    silent_args: Vec<String>,
) -> Result<(), String> {
    let path = download(&app, &id, &url, &file_name, size).await?;
    emit(&app, &id, "install", 0, 0);
    let file = path.to_string_lossy().into_owned();
    let result = if file.to_lowercase().ends_with(".msi") {
        // /passive mostra só a barra de progresso e pede administrador se o pacote precisar.
        let mut args = vec!["/i".to_string(), format!("\"{file}\""), "/passive".into(), "/norestart".into()];
        args.extend(silent_args);
        run_and_wait(msiexec(), args).await
    } else {
        run_and_wait(file, silent_args).await
    };
    let _ = std::fs::remove_file(&path);
    emit(&app, &id, "done", 0, 0);
    result
}

#[tauri::command]
async fn uninstall_app(
    app: AppHandle,
    id: String,
    uninstall: Option<String>,
    quiet: Option<String>,
    args: Vec<String>,
) -> Result<(), String> {
    let (exe, rest, extra) = match (quiet.filter(|q| !q.trim().is_empty()), uninstall) {
        (Some(q), _) => {
            let (e, r) = split_cmdline(&q);
            (e, r, vec![])
        }
        (None, Some(u)) => {
            let (e, r) = split_cmdline(&u);
            (e, r, args)
        }
        (None, None) => return Err("nouninstall".into()),
    };
    if exe.to_lowercase().contains("msiexec") {
        let code = msi_product_code(&rest).ok_or("nouninstall")?;
        emit(&app, &id, "uninstall", 0, 0);
        let r = run_and_wait(msiexec(), vec!["/x".into(), code, "/passive".into(), "/norestart".into()]).await;
        emit(&app, &id, "done", 0, 0);
        return r;
    }
    let mut all = vec![rest];
    all.extend(extra);
    emit(&app, &id, "uninstall", 0, 0);
    let r = run_and_wait(exe, all).await;
    emit(&app, &id, "done", 0, 0);
    r
}

#[tauri::command]
fn launch_app(app: AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("notfound".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("badurl".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    windows: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), windows: cfg!(windows) }
}

/// Atualiza o próprio ShowKit: descarrega o instalador novo, fecha-se, instala e volta a abrir.
#[tauri::command]
async fn self_update(app: AppHandle, url: String, file_name: String, size: u64, silent_args: Vec<String>) -> Result<(), String> {
    let path = download(&app, "showkit", &url, &file_name, size).await?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let args: Vec<String> = silent_args.iter().map(|a| ps_quote(a)).collect();
    let arglist = if args.is_empty() { String::new() } else { format!(" -ArgumentList {}", args.join(",")) };
    let script = format!(
        "Start-Sleep -Seconds 2; $p = Start-Process -FilePath {}{} -Wait -PassThru; Remove-Item -LiteralPath {} -ErrorAction SilentlyContinue; Start-Process -FilePath {}",
        ps_quote(&path.to_string_lossy()),
        arglist,
        ps_quote(&path.to_string_lossy()),
        ps_quote(&me.to_string_lossy())
    );
    ps_command(&script).spawn().map_err(|e| format!("ps:{e}"))?;
    emit(&app, "showkit", "install", 0, 0);
    tokio::time::sleep(Duration::from_millis(400)).await;
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------- arranque

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_catalog,
            get_icon,
            get_release,
            get_installed,
            install_app,
            uninstall_app,
            launch_app,
            open_folder,
            open_url,
            app_info,
            self_update
        ])
        .run(tauri::generate_context!())
        .expect("erro ao arrancar o ShowKit");
}

// ---------------------------------------------------------------- testes

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, name: &str) -> UninstallEntry {
        UninstallEntry { key: key.into(), name: name.into(), ..Default::default() }
    }

    #[test]
    fn matches_by_registry_key_then_name() {
        let entries = vec![
            entry("{6B0C4C2E-5A51-4F0B-9E0C-2C7D9A1F5E11}_is1", "PLAYERSLICE"),
            entry("abc", "MapSimulator Pro"),
            entry("7a1f-guid", "MapSim 0.54.0"),
        ];
        let ps = DetectSpec {
            id: "playerslice".into(),
            detect: Detect { registry_key: Some("{6b0c4c2e-5a51-4f0b-9e0c-2c7d9a1f5e11}_IS1".into()), display_name: None, alt_names: vec![] },
            exe: None,
            exe_search: vec![],
        };
        assert_eq!(find_entry(&ps, &entries).unwrap().name, "PLAYERSLICE");
        let ms = DetectSpec {
            id: "mapsim".into(),
            detect: Detect { registry_key: None, display_name: Some("MapSim".into()), alt_names: vec![] },
            exe: None,
            exe_search: vec![],
        };
        assert_eq!(find_entry(&ms, &entries).unwrap().key, "7a1f-guid");
        let none = DetectSpec { id: "x".into(), detect: Detect::default(), exe: None, exe_search: vec![] };
        assert!(find_entry(&none, &entries).is_none());
    }

    #[test]
    fn exe_from_display_icon() {
        assert_eq!(exe_from_icon(r#""C:\A B\MapSim.exe",0"#).as_deref(), Some(r"C:\A B\MapSim.exe"));
        assert_eq!(exe_from_icon(r"C:\A\PLAYERSLICE.exe").as_deref(), Some(r"C:\A\PLAYERSLICE.exe"));
        assert_eq!(exe_from_icon(r"C:\A\app.ico"), None);
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(
            split_cmdline(r#""C:\Program Files\X\unins000.exe""#),
            (r"C:\Program Files\X\unins000.exe".into(), String::new())
        );
        assert_eq!(
            split_cmdline(r#""C:\Users\d\AppData\Local\Programs\mapsim\Uninstall MapSim.exe" /currentuser /S"#),
            (r"C:\Users\d\AppData\Local\Programs\mapsim\Uninstall MapSim.exe".into(), "/currentuser /S".into())
        );
        assert_eq!(
            split_cmdline(r"C:\Program Files\X\unins000.exe /SILENT"),
            (r"C:\Program Files\X\unins000.exe".into(), "/SILENT".into())
        );
    }

    #[test]
    fn quotes_for_powershell() {
        assert_eq!(ps_quote("C:\\Dan's\\a.exe"), "'C:\\Dan''s\\a.exe'");
        let s = start_process_script("C:\\x.exe", &["/S".into(), "".into()]);
        assert!(s.contains("-FilePath 'C:\\x.exe' -ArgumentList '/S' -Wait"));
    }

    #[test]
    fn parses_release_and_picks_asset() {
        let v = json!({
            "tag_name": "v0.54.0", "published_at": "2026-11-21T17:40:25Z", "body": "notas", "html_url": "u",
            "assets": [
                {"name": "MapSim-Setup-0.54.0.exe", "browser_download_url": "a", "size": 1},
                {"name": "MapSim-Setup.exe", "browser_download_url": "b", "size": 2}
            ]
        });
        let r = parse_release(&v, r"^MapSim-Setup\.exe$").unwrap();
        assert_eq!(r.version, "0.54.0");
        assert_eq!(r.asset_url.as_deref(), Some("b"));
        let vh = json!({"tag_name":"v0.9.0","assets":[
            {"name":"VIDEOHOST-PLAYER-Setup-0.9.0.exe.sha256","browser_download_url":"x","size":1},
            {"name":"VIDEOHOST-PLAYER-Setup-0.9.0.exe","browser_download_url":"y","size":9}]});
        assert_eq!(parse_release(&vh, r"^VIDEOHOST-PLAYER-Setup-.*\.exe$").unwrap().asset_url.as_deref(), Some("y"));
    }

    #[test]
    fn allowed_downloads_only_from_github() {
        assert!(is_allowed_download("https://github.com/NunesDanielPT/PlayerSlice/releases/download/v1/PLAYERSLICE-Setup.exe"));
        assert!(!is_allowed_download("https://evil.example/x.exe"));
        assert!(!is_allowed_download("https://github.com/someoneelse/x/archive/main.zip"));
    }

    #[test]
    fn msi_helpers() {
        assert_eq!(
            msi_product_code("MsiExec.exe /X{1A2B3C4D-1111-2222-3333-444455556666}").as_deref(),
            Some("{1A2B3C4D-1111-2222-3333-444455556666}")
        );
        assert_eq!(msi_product_code("C:\\x\\unins000.exe"), None);
        std::env::set_var("SHOWKIT_TEST_DIR", "/tmp/sk");
        assert_eq!(expand_env("%SHOWKIT_TEST_DIR%\\ArtCraft"), "/tmp/sk\\ArtCraft");
        assert_eq!(expand_env("%NAO_EXISTE_XYZ%\\a"), "%NAO_EXISTE_XYZ%\\a");
        assert!(is_allowed_download("https://github.com/storytold/photocraft/releases/download/v0.7.0/photocraft-0.7.0-windows-x64.msi"));
        let re = Regex::new(r"^(photocraft)-.*-windows-x64\.msi$").unwrap();
        assert!(re.is_match("photocraft-0.7.0-windows-x64.msi"));
        assert!(!re.is_match("photocraft-0.7.0-windows-arm64.msi"));
    }

    #[test]
    fn matches_alt_names() {
        let entries = vec![entry("{G}", "PrintCraft")];
        let spec = DetectSpec {
            id: "pdfcraft".into(),
            detect: Detect { registry_key: None, display_name: Some("PdfCraft".into()), alt_names: vec!["PrintCraft".into()] },
            exe: None,
            exe_search: vec![],
        };
        assert_eq!(find_entry(&spec, &entries).unwrap().key, "{G}");
    }

    #[test]
    fn pages_parsing() {
        assert_eq!(
            tag_from_location("https://github.com/storytold/photocraft/releases/tag/v0.7.0", "storytold/photocraft").as_deref(),
            Some("v0.7.0")
        );
        assert_eq!(tag_from_location("https://github.com/storytold/photocraft/releases", "storytold/photocraft"), None);
        assert_eq!(tag_from_location("https://login.example/portal", "storytold/photocraft"), None);
        let html = r#"<a href="/storytold/photocraft/releases/download/v0.7.0/photocraft-0.7.0-windows-x64.msi" rel="nofollow">
            <a href="/storytold/photocraft/releases/download/v0.7.0/SHA256SUMS.txt">
            <a href="/storytold/photocraft/archive/refs/tags/v0.7.0.zip">"#;
        let names = asset_names_from_html(html, "storytold/photocraft", "v0.7.0");
        assert_eq!(names, vec!["photocraft-0.7.0-windows-x64.msi", "SHA256SUMS.txt"]);
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("NunesDanielPT/PlayerSlice"), "NunesDanielPT_PlayerSlice");
        assert_eq!(safe_name(".."), "file");
    }
}
