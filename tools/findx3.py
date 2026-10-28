import io; s=io.open(r'C:\Users\Maxx\Desktop\natal\kiosk_foto\backend\admin.html',encoding='utf-8').read(); idx=s.find('carregarCatalogo'); print(idx); print(s[idx:idx+200] if idx>=0 else '')
