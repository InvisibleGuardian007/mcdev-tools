$p = Get-Process -Id 20708
$p.Modules | Where-Object { $_.ModuleName -match 'python|yappi|modsdk|ModSDK' } | ForEach-Object { $_.ModuleName + ' | ' + $_.FileName }
