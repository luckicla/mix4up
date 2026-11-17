; Mix4Up: antes de copiar nada, el motor (mix4up-core.exe) que la app arranca
; tendría sus archivos ocupados y una actualización silenciosa fallaría.
; (Solo el de Mix4Up: MixUp, si está abierta, sigue tal cual.)
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM mix4up-core.exe'
  Pop $0
  Sleep 300
!macroend
