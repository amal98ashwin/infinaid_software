[Setup]
AppId=Infinaid.EEGStudio.Desktop
AppName=Infinaid EEG Studio
AppVersion=1.0
DefaultDirName={localappdata}\Programs\Infinaid EEG Studio
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=release
OutputBaseFilename=Infinaid-EEG-Studio-Windows-x64
Compression=lzma2/fast
UninstallDisplayName=Infinaid EEG Studio

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Infinaid EEG Studio"; Filename: "{app}\runtime\python.exe"; Parameters: "-X utf8 ""{app}\launch.py"""; WorkingDir: "{app}"

[Run]
Filename: "{app}\runtime\python.exe"; Parameters: "-X utf8 ""{app}\launch.py"""; WorkingDir: "{app}"; Description: "Open Infinaid EEG Studio"; Flags: postinstall nowait skipifsilent
