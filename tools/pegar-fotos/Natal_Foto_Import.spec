# -*- mode: python ; coding: utf-8 -*-
#
# Build em modo "onedir" (pasta) de proposito:
#  - onefile extrai o app inteiro numa pasta temporaria a cada start, o que
#    demora 10-40s na primeira execucao (antivirus escaneando) e dispara
#    heuristicas de falso positivo (o PDV chegava a matar o processo antes de
#    ele abrir a porta 8099);
#  - onedir inicia em ~1s, nao usa tmpdir e nao tem pai+filho do bootloader.
# UPX desligado: compressao UPX e um dos maiores gatilhos de antivirus em exe
# PyInstaller. O espaco extra nao compensa o risco em PC de evento.

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('shared.py', '.'), ('peer.py', '.'), ('notify.py', '.'), ('natal_icon.png', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Natal_Foto_Import',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['natal.ico'],
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='Natal_Foto_Import',
)
