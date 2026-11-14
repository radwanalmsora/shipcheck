#!/usr/bin/env python3
"""Build a VS Code .vsix without vsce (a VSIX is a zip with a manifest).
Usage: python3 tools/build_vsix.py [--publisher YOUR_ID]
Alternative: npx @vscode/vsce package
"""
import json, os, sys, zipfile, fnmatch
from xml.sax.saxutils import escape

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg_path = os.path.join(root, 'package.json')
pkg = json.load(open(pkg_path, encoding='utf-8'))
if '--publisher' in sys.argv:
    pkg['publisher'] = sys.argv[sys.argv.index('--publisher') + 1]
    json.dump(pkg, open(pkg_path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(pkg_path, 'a').write('\n')

ignore = [l.strip() for l in open(os.path.join(root, '.vscodeignore')) if l.strip() and not l.startswith('#')]
ignore += ['.vscodeignore', 'package-lock.json', 'node_modules/**', 'media/icon-*.png', 'LICENSE.txt.bak']
def ignored(rel):
    return any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(os.path.basename(rel), g) or rel.startswith(g.rstrip('*').rstrip('/') + '/') and g.endswith('/**') for g in ignore)

files = []
for d, _, fs in os.walk(root):
    for f in fs:
        full = os.path.join(d, f); rel = os.path.relpath(full, root).replace(os.sep, '/')
        if rel.startswith('.git/') or ignored(rel): continue
        files.append(rel)
files.sort()

ext_id = pkg['name']; ver = pkg['version']; pub = pkg['publisher']
tags = ','.join(pkg.get('keywords', [])); cats = ','.join(pkg.get('categories', []))
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(ext_id)}" Version="{escape(ver)}" Publisher="{escape(pub)}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(tags)}</Tags>
    <Categories>{escape(cats)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{escape(pkg['repository']['url'])}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="{escape(pkg['repository']['url'])}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="{escape(pkg['repository']['url'])}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{escape(pkg['bugs']['url'])}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{escape(pkg['homepage'])}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="{pkg['galleryBanner']['color']}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="{pkg['galleryBanner']['theme']}" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/{pkg['icon']}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{pkg['icon']}" Addressable="true" />
  </Assets>
</PackageManifest>
'''
ctypes = '''<?xml version="1.0" encoding="utf-8"?>
<Types>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'''
out = os.path.join(root, f'{ext_id}-{ver}.vsix')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ctypes)
    z.writestr('extension.vsixmanifest', manifest)
    for rel in files:
        z.write(os.path.join(root, rel), 'extension/' + rel)
print('built', out, f'({os.path.getsize(out)//1024} KB, {len(files)} files)')
