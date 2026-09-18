# Sicherheit / Security

## Sicherheitslücke melden

Bitte **kein öffentliches Issue** für Sicherheitsprobleme. Nutze stattdessen
[Security → Report a vulnerability](https://github.com/umesh-adhikari/Augen-Pause/security/advisories/new)
(private Meldung direkt an den Maintainer). Hilfreich sind: betroffene Version, Betriebssystem,
Schritte zum Nachstellen und die erwartete Auswirkung.

Antwort in der Regel innerhalb weniger Tage. Da es sich um ein Freizeitprojekt handelt, gibt es
keine zugesicherte Reaktionszeit.

*Please do not open a public issue for security problems – use the private
"Report a vulnerability" link above.*

## Unterstützte Versionen

| Version | Sicherheitsupdates |
|---|---|
| neueste Release-Version | ✅ |
| ältere Releases | ❌ – bitte aktualisieren |

## Was die App tut – und was nicht

- **Genau eine ausgehende Verbindung: die Update-Prüfung.** AugenPause fragt per HTTPS bei
  `https://api.github.com/repos/umesh-adhikari/Augen-Pause/releases` nach, ob es eine neuere Version gibt –
  rund 30 Sekunden nach dem Start und danach alle 24 Stunden (einstellbar 6–168 Stunden, während einer
  Pflicht-Pause gar nicht). **Gesendet wird nichts außer der Anfrage selbst**: kein Konto, kein Token, keine
  Cookies, keine Kennung, keine Statistik, keine Einstellungen, keine Telemetrie – nur was jede HTTPS-Anfrage
  mitbringt (IP-Adresse, `User-Agent: AugenPause/<Version>`, `Accept: application/vnd.github+json`).
  Grenzen: 10 s Zeitlimit, 256 KB Antwortgröße, strikte JSON-Prüfung, Fehler bleiben still (kein Dialog).
  **Abschaltbar** unter *Einstellungen → Updates* (`updates.autoCheck: false`) – danach geht keine einzige
  Verbindung mehr raus.
- **Kein automatischer Installer außerhalb von Setup und AppImage.** Nur die Windows-Setup-Installation und
  das Linux-AppImage können ein Update laden (electron-updater, `autoDownload = false`, `allowDowngrade = false`,
  Installation erst beim Beenden) – und nur, wenn der Nutzer es anstößt. Auf **macOS, in der portablen
  Windows-Version und bei deb/rpm lädt und startet die App nichts**; sie öffnet die passende Datei bzw. die
  Release-Seite im Browser. `shell.openExternal` akzeptiert ausschließlich URLs, die mit
  `https://github.com/umesh-adhikari/Augen-Pause/releases/` beginnen; alles andere wird abgelehnt und geloggt.
  Release-Texte werden nur als reiner Text angezeigt, nie als HTML oder Markdown gerendert.
- **Sonst keine Netzwerkverbindungen.** Die Oberflächen laden ausschließlich lokale Seiten über ein eigenes
  `app://`-Protokoll und dürfen per CSP (`connect-src 'none'`) gar keine Verbindung aufbauen; die Update-Prüfung
  läuft allein im Hauptprozess. Es gibt keine Telemetrie, keine Konten, keine Cloud.
- **Alle Daten bleiben lokal** (`settings.json`, `stats.json`, `session.json` im Benutzerprofil).
- **Gehärtete Renderer:** Sandbox, Context-Isolation, `nodeIntegration: false`, strikte
  Content-Security-Policy, blockierte Navigation, blockierte Berechtigungsanfragen, geprüfte
  IPC-Aufrufe mit Whitelist pro Fenster, electron-builder-Fuses (kein `runAsNode`, kein
  `NODE_OPTIONS`, ASAR-Integritätsprüfung).
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), Abschnitt 7, 11 und 12; Kurzfassung auf Englisch
  im README: [Updates](README.md#updates).

*In short: the only outgoing request is an update check against `api.github.com`; it sends nothing but the
request itself and can be switched off. On macOS, the portable Windows build and deb/rpm the app never
downloads or executes an installer.*

## Die Pausensperre ist kein Sicherheitsmechanismus

Die Pflicht-Pause ist eine **Selbstverpflichtung**, keine Zugriffskontrolle. Sie hält den
Bildschirm mit einem transparenten Fenster besetzt und blockiert die Bedienelemente der App.
Bewusst **nicht** blockiert werden `Strg+Alt+Entf`, `Win+L`, der Ein-/Ausschalter und der
Task-Manager. Wer die App abschießt, beendet die Sperre – die Pause wird beim nächsten Start
nachgeholt. Das ist Absicht: Eine App, die sich nicht mehr beenden lässt, wäre selbst ein Risiko.

## ⚠️ Legacy-Builds für altes macOS

Dateien mit `legacy` im Namen (macOS 10.15–12) sind mit **Electron 32** gebaut, der letzten
Version mit Catalina-Unterstützung. Electron 32 bekommt **keine Sicherheitsupdates** mehr.
Nutze sie nur, wenn dein macOS älter als 13 (Ventura) ist, und wechsle auf den regulären Build,
sobald du kannst.
