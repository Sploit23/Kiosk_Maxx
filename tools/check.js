const fs=require('fs');const s=fs.readFileSync('vendas.html','utf8');const m=s.match(/<script[^>]*>([\s\S]*?)<\/script>/i);try{new Function(m[1]);console.log('ok')}catch(e){console.log(e.message);}
