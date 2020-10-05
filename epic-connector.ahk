#NoEnv  ; Recommended for performance and compatibility with future AutoHotkey releases.
; #Warn  ; Enable warnings to assist with detecting common errors.
SendMode Input  ; Recommended for new scripts due to its superior speed and reliability.
SetWorkingDir %A_ScriptDir%  ; Ensures a consistent starting directory.
#SingleInstance, Force
SetMouseDelay, 0
#NoTrayIcon

Msgbox % "ONLY TOUCH THE MOUSE/KEYBOARD IF THE BROWSER ASKS FOR A CAPTCHA"
RunWait, get-exchange-code.exe
Run, epicconnection.exe
WinGet, focused, ProcessName, A
timeout := A_TickCount
while (focused != "epicconnection.exe")
{
	WinGet, focused, ProcessName, A
	Sleep, 50
	if (A_TickCount - timeout > 10000)
	{
		ExitApp
	}
}
WinGetPos,,, w, h, A
w := w / 2
h := h / 2
MouseMove, w, h
Sleep, 25
SendInput {RButton}
SendInput {Enter}
Sleep, 100
ExitApp