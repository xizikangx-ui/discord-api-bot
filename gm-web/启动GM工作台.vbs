Option Explicit
Dim shell, fs, folder, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
folder = fs.GetParentFolderName(WScript.ScriptFullName)
command = """" & folder & "\runtime\node.exe"" """ & folder & "\local\server.cjs"""
shell.Run command, 0, False
