Option Explicit
Dim shell, fso, root, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd /c cd /d """ & root & """ && node video\server.mjs"
shell.Run command, 0, False
WScript.Sleep 1400
shell.Run "http://127.0.0.1:8787/", 1, False
