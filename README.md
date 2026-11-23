<p align="center"><img src="icons/showkit.png" width="96" alt="ShowKit"></p>

# ShowKit

**PT** · Launcher das aplicações de Daniel Nunes para espetáculos e eventos. Instala, atualiza, abre e desinstala cada app a partir dos Releases do GitHub. Quem tem o ShowKit instalado vê automaticamente todas as apps que estiverem no catálogo.

**EN** · Launcher for Daniel Nunes's show and event apps. Installs, updates, opens and uninstalls each app from its GitHub Releases. Anyone with ShowKit installed automatically sees every app listed in the catalog.

Criado por / Created by **Daniel Nunes** — [github.com/NunesDanielPT](https://github.com/NunesDanielPT)

---

## Download

[**ShowKit-Setup.exe**](https://github.com/NunesDanielPT/launcher-catalog/releases/latest/download/ShowKit-Setup.exe) (Windows 10/11, 64 bits)

## Como funciona

```
apps.json (este repo) ──► ShowKit lê o catálogo
                          ├─ API do GitHub: última release de cada app
                          ├─ Registo do Windows: o que já está instalado e em que versão
                          └─ Descarrega o instalador e corre-o em modo silencioso
```

- **Catálogo** — [`apps.json`](apps.json) e [`icons/`](icons). O ShowKit lê-os diretamente da branch `main`, por isso alterar o catálogo **não precisa de versão nova do ShowKit**.
- **Versões** — vêm dos GitHub Releases de cada app (`releases/latest`). O instalador é escolhido pelo padrão `asset`.
- **Deteção** — chave `Uninstall` do registo (`registryKey` = AppId do Inno Setup + `_is1`) ou, em alternativa, o início do `displayName`.
- **Auto-update do ShowKit** — o próprio ShowKit está em `launcher` no catálogo; quando há release nova mostra um aviso e atualiza-se com um clique.

## Softwares do ArtCraft

O ShowKit também mostra, numa secção à parte (`groups` no `apps.json`), as apps open-source da [ArtCraft](https://getartcraft.com/apps) — PhotoCraft, GridCraft, WordCraft, CADCraft, Craft Anything e as restantes. Instalam-se a partir dos Releases de cada repo (`<app>-<versão>-windows-x64.msi`). Os dados e ícones vêm do catálogo do [ArtCraft Launcher](https://github.com/storytold/craft-launcher) (MIT / Apache-2.0); as apps são da ArtCraft e não de Daniel Nunes.

## Adicionar uma app nova ao catálogo

Acrescenta uma entrada em `apps`, mete o ícone (PNG 256×256) em `icons/` e faz push:

```json
{
  "id": "minha-app",
  "name": "MINHA",
  "nameAccent": "APP",
  "accent": "#ff3b6b",
  "icon": "icons/minha-app.png",
  "repo": "NunesDanielPT/MinhaApp",
  "category": { "pt": "…", "en": "…" },
  "tagline": { "pt": "…", "en": "…" },
  "description": { "pt": "…", "en": "…" },
  "asset": "^MinhaApp-Setup.*\\.exe$",
  "silentArgs": ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"],
  "detect": { "registryKey": "{GUID-DO-APPID}_is1", "displayName": "MINHA APP" },
  "exe": "MinhaApp.exe",
  "uninstallArgs": ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]
}
```

| Instalador | `silentArgs` | `uninstallArgs` |
|---|---|---|
| Inno Setup | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS` | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` |
| NSIS (electron-builder, Tauri) | `/S` | `/S` |

Requisitos da app: o repositório (ou um repo `-releases`) tem de ser **público** e cada release tem de ter o instalador `.exe` como asset.

## Desenvolvimento

O código do ShowKit está em [`app/`](app) — [Tauri 2](https://tauri.app) (Rust) + HTML/CSS/JS sem framework.

```bash
cd app
npm install
npx tauri dev          # abre a app
npx tauri build        # gera o instalador NSIS
cargo test --manifest-path src-tauri/Cargo.toml
```

Para testar um catálogo local sem fazer push: `SHOWKIT_CATALOG=C:\caminho\apps.json`.
Abrir `app/ui/index.html` num browser (servido a partir da raiz do repo) mostra a interface com dados simulados.

**Lançar uma versão nova do ShowKit:** sobe a versão em `app/src-tauri/tauri.conf.json` e `app/src-tauri/Cargo.toml`, acrescenta a secção no [`CHANGELOG.md`](CHANGELOG.md) e faz push para `main`. O GitHub Actions compila em Windows e publica a release `vX.Y.Z` com o `ShowKit-Setup.exe`.
