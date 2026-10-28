import io; s=io.open(r'C:\Users\Maxx\Desktop\natal\kiosk_foto\backend\admin.html',encoding='utf-8').read(); i=s.find('precos.save'); print(s[i-40:i+140] if i>=0 else 'no')
