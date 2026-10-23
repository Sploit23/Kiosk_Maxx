; Regras de firewall do importador de fotos do cartão (Pegar_Fotos).
; O instalador roda elevado (perMachine), então o netsh funciona aqui — o app
; em si continua asInvoker e NUNCA pede UAC no boot.
;
; Portas abertas para o Natal_Foto_Import.exe:
;   8099/TCP  = servidor HTTP que entrega os lotes para o outro PC
;   50000/UDP = descoberta automática do PC do fotógrafo na rede local
;
; A impressora/sidecar Java (8080) e o core Node (9877) escutam só em
; localhost, então não precisam de regra de entrada.

!macro _NatalFirewallDelete
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Maxx Natal Importador TCP"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Maxx Natal Importador UDP"'
  Pop $0
!macroend

!macro customInstall
  !insertmacro _NatalFirewallDelete
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Maxx Natal Importador TCP" dir=in action=allow protocol=TCP localport=8099 program="$INSTDIR\resources\importador\Natal_Foto_Import.exe" profile=any enable=yes'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Maxx Natal Importador UDP" dir=in action=allow protocol=UDP localport=50000 program="$INSTDIR\resources\importador\Natal_Foto_Import.exe" profile=any enable=yes'
  Pop $0
!macroend

!macro customUnInstall
  !insertmacro _NatalFirewallDelete
!macroend
