import io; s=io.open(r'backend/api.php',encoding='utf-8').read(); i=s.find('precos.list'); print(s[i:i+150] if i>=0 else 'no')
