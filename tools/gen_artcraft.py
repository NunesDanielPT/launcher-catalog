import json, tomllib, sys
src, catalog = sys.argv[1], sys.argv[2]
d = tomllib.load(open(src, 'rb'))
PT = {  # categoria, frase (pt-PT)
 'photocraft': ('Edição de imagem', 'O editor de imagem que já sabes usar.'),
 'vectorcraft': ('Ilustração vetorial', 'Ilustração vetorial, com ferramentas familiares e efeitos editáveis.'),
 'filmcraft': ('Edição de vídeo, cor e som', 'Edição de vídeo profissional, refeita de raiz.'),
 'lightcraft': ('Biblioteca de fotos e revelação RAW', 'As tuas fotos. Os teus píxeis. O teu computador.'),
 'pdfcraft': ('Ler, organizar e proteger PDFs', 'A bancada de trabalho open-source para PDFs.'),
 'effectcraft': ('Motion graphics e efeitos visuais', 'Motion graphics e efeitos visuais.'),
 'anicraft': ('Animação vetorial 2D', 'Animação vetorial numa timeline que já conheces.'),
 'designcraft': ('Paginação e publicação', 'Paginação e publicação.'),
 'figcraft': ('Design de interfaces e protótipos', 'Design de interfaces e protótipos.'),
 'soundcraft': ('Gravação, edição e mistura de áudio', 'Grava, edita e mistura o teu áudio.'),
 'wordcraft': ('Escrita e design de documentos', 'O processador de texto que conheces, nativo e offline.'),
 'deckcraft': ('Apresentações e slides', 'Cria slides, conta histórias e apresenta.'),
 'cadcraft': ('Desenho técnico (CAD)', 'Desenho técnico assistido por computador, com um fluxo familiar.'),
 'gridcraft': ('Folhas de cálculo e dados', 'Folhas de cálculo que já sabes usar.'),
 'texturecraft': ('Pintura de texturas 3D', 'Pinta texturas em modelos 3D.'),
 'materialcraft': ('Materiais procedurais', 'Cria materiais com grafos de nós.'),
 'craft-anything': ('Perceber como funciona qualquer software', 'Vê como funciona qualquer site, app ou jogo, e depois cria o teu.'),
 'solidcraft': ('CAD 3D paramétrico', 'CAD 3D paramétrico, com esboços e sólidos editáveis.'),
 'mailcraft': ('Email, calendário e contactos', 'Email, calendário, contactos e tarefas, numa só app nativa.'),
}
apps = []
for a in d['apps']:
    i, name = a['id'], a['name']
    if name.endswith('Craft') and len(name) > 5:
        n, acc = name[:-5], 'Craft'
    else:
        n, acc = name, ''
    names = [name] + list(a.get('former_names') or [])
    stems = [i] + list(a.get('former_ids') or [])
    head = (a.get('details') or {}).get('headline', a['tagline'])
    cat_pt, head_pt = PT[i]
    roots = ['%ProgramFiles%\\ArtCraft\\{n}', '%ProgramFiles%\\{n}', '%LOCALAPPDATA%\\Programs\\ArtCraft\\{n}', '%LOCALAPPDATA%\\Programs\\{n}']
    e = {
        'id': 'artcraft-' + i, 'group': 'artcraft', 'publisher': a['publisher'],
        'name': n, 'nameAccent': acc, 'accent': '#%02x%02x%02x' % tuple(a['ink_dark']),
        'icon': f'icons/artcraft/{i}.png', 'repo': a['repo'],
        'category': {'pt': cat_pt, 'en': a['tagline']},
        'tagline': {'pt': head_pt, 'en': head},
        'asset': '^(' + '|'.join(stems) + r')-.*-windows-x64\.msi$',
        'silentArgs': [],
        'detect': {'displayName': name, 'altNames': names[1:]},
        'exe': f'{i}.exe',
        'exeSearch': [r.format(n=nm) for nm in names for r in roots],
        'uninstallArgs': [],
        'website': a.get('site') or f'https://getartcraft.com/apps/{i}',
    }
    apps.append(e)
cat = json.load(open(catalog))
cat['groups'] = [{
    'id': 'artcraft', 'title': {'pt': 'SOFTWARES DO ARTCRAFT', 'en': 'ARTCRAFT SOFTWARE'},
    'note': {'pt': 'Apps open-source da ArtCraft (getartcraft.com). Não são feitas por Daniel Nunes.',
             'en': 'Open-source apps by ArtCraft (getartcraft.com). Not made by Daniel Nunes.'},
    'url': 'https://getartcraft.com/apps'}]
cat["groups"][0]["apps"] = [dict((k, v) for k, v in x.items() if k != "group") for x in apps]
json.dump(cat, open(catalog, 'w'), ensure_ascii=False, indent=2)
open(catalog, 'a').write('\n')
print(len(apps), 'apps ArtCraft')
