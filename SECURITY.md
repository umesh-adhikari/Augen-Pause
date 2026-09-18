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

- **Keine Netzwerkverbindungen.** Die App lädt ausschließlich lokale Seiten über ein eigenes
  `app://`-Protokoll. Es gibt keine Telemetrie, keine Konten, keine Cloud.
- **Alle Daten bleiben lokal** (`settings.json`, `stats.json`, `session.json` im Benutzerprofil).
- **Gehärtete Renderer:** Sandbox, Context-Isolation, `nodeIntegration: false`, strikte
  Content-Security-Policy, blockierte Navigation, blockierte Berechtigungsanfragen, geprüfte
  IPC-Aufrufe mit Whitelist pro Fenster, electron-builder-Fuses (kein `runAsNode`, kein
  `NODE_OPTIONS`, ASAR-Integritätsprüfung).
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), Abschnitt 7 und 11.

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
