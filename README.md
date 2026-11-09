<!-- AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05 -->

# Pomodoro

Eine lokale Pomodoro-Web-App mit Groove Salad als optionalem Live-Audiostream. Der Timer läuft im Browser; der Node.js-Server stellt die Oberfläche und einen optionalen Metadaten-Diagnose-Endpunkt bereit.

## Starten unter Windows

1. Installiere eine aktuelle Node.js-LTS-Version (mindestens Node.js 24.14.0).
2. Doppelklicke auf `start.cmd`. Ein Browser öffnet nach kurzem Moment `http://127.0.0.1:3000`.
3. Zum Beenden schließe das Server-Konsolenfenster mit `Ctrl+C`.

Alternativ öffne ein Terminal in diesem Ordner und starte `node server.mjs`. Öffne anschließend `http://127.0.0.1:3000` selbst im Browser. In PowerShell lässt sich ein anderer Port zum Beispiel mit `$env:PORT=3001; node server.mjs` setzen; `start.cmd` verwendet den Standardport 3000.

Es ist kein `npm install` erforderlich. Die App nutzt ausschließlich Node.js und Browser-APIs.

## Bedienung

- **Start / Fortsetzen**, **Pause** und **Zurücksetzen** steuern die aktuelle Phase. Zurücksetzen hält sie an und stellt ihre volle, derzeit konfigurierte Dauer wieder her.
- Standardzeiten sind 25 Minuten Arbeit, 5 Minuten kurze Pause und 15 Minuten lange Pause. Nach jeweils vier abgeschlossenen Arbeitsphasen folgt eine lange Pause. Die nächste Phase startet automatisch.
- Die drei Zeiten lassen sich zwischen 1 und 180 Minuten einstellen. Eine Änderung wirkt auf folgende Phasen; eine laufende oder pausierte Phase behält ihre Restzeit.
- Wähle im SomaFM-Panel einen Sender aus der vollständigen, alphabetischen SomaFM-Liste. Die Senderauswahl wird zusammen mit Lautstärke und Stummschaltung lokal im Browser gespeichert.
- Beim Wechsel wird der bisherige Stream sofort gestoppt. Der neue Sender spielt nur während einer laufenden Arbeitsphase, sofern Musik nicht stummgeschaltet ist; Auswahl oder Auflösung der Streamadressen startet pausierte oder stummgeschaltete Musik nicht.
- Während der Wiedergabe fragt der Browser SomaFM direkt alle 30 Sekunden nach Interpret und Titel des ausgewählten Senders. Beim Senderwechsel werden alte Titel verworfen und die neuen Metadaten sofort abgefragt. Wenn keine Metadaten verfügbar sind, erscheint ein neutraler Hinweis; wegen der Pufferung des Live-Streams kann der angezeigte Titel vom gerade hörbaren Moment abweichen.
- Ist die Senderliste nicht erreichbar, bleibt Groove Salad verfügbar und das Panel zeigt einen Hinweis. Nicht erreichbare Streamadressen lassen sich über „Erneut verbinden“ erneut laden; die Senderliste kann separat neu geladen werden.

## Tests

Führe im Projektordner `node --test` aus. Timer, Audiosteuerung und HTTP-Auslieferung werden mit Node.js-eigenen Tests geprüft. Audiotests verwenden ein Testobjekt und stellen keine Verbindung zu SomaFM her.

## Dateien

- `server.mjs`, `start.cmd`: lokaler HTTP-Server und Windows-Starter
- `public/index.html`, `public/styles.css`, `public/app.mjs`: barrierearme Web-Oberfläche
- `public/timer.mjs`, `public/track.mjs`: Timerzustände, versionierte Speicherung und senderbezogener Titelabruf
- `public/stations.mjs`, `public/audio.mjs`: SomaFM-Senderverzeichnis, PLS-Auflösung und Audiosteuerung
- `test/*.test.mjs`: Timer-, Sender-, Audio- und Servertests

## Offline- und Hintergrundgrenzen

### Titelinformationen und Netzwerkzugang

Die Browseroberfläche lädt das offizielle Verzeichnis unter `https://somafm.com/channels.json` und löst die veröffentlichte MP3-PLS-Datei des ausgewählten Senders in direkte SomaFM-Streamadressen auf. Verzeichnis, Playlists und Metadaten werden ohne Zugangsdaten abgerufen; SomaFM erlaubt den Browserzugriff per CORS (`Access-Control-Allow-Origin: *`). Wenn das Verzeichnis nicht erreichbar ist, steht Groove Salad mit den bekannten Streamadressen als Fallback bereit.

Titel und Interpret fragt der Browser getrennt vom Audiostream unter `https://somafm.com/songs/<sender-id>.json` ab. Die Anfrage erfolgt nur während tatsächlicher Wiedergabe; beim Senderwechsel werden laufende alte Abfragen abgebrochen. Der Server-Endpunkt `/api/current-track` bleibt als optionaler Groove-Salad-Diagnose-Endpunkt verfügbar und wird nicht als normaler Anzeigeweg verwendet. Der Browser kann Musik empfangen, obwohl der separate Node.js-Abruf dieser Metadaten nicht funktioniert.

Bei dauerhaftem „Titel derzeit nicht verfügbar“ prüfe zuerst im Browser-Netzwerkbereich den GET auf `https://somafm.com/songs/<sender-id>.json` für den ausgewählten Sender. Ein `TIMEOUT` des lokalen Node.js-Abrufs kann weiterhin auftreten, aber die App verwendet diesen Abruf nicht für die Titelanzeige. Der lokale Diagnose-Endpunkt unter `http://127.0.0.1:3000/api/current-track` kann weiterhin unabhängig davon verwendet werden; eine erfolgreiche Antwort enthält `artist` und `title`. Bei HTTP 502 enthält die JSON-Antwort `code` und eine deutschsprachige `message`; kopiere diese Felder sowie ein vorhandenes `nodeCode` zur Diagnose. 502 bedeutet, dass dieser lokale Abruf fehlgeschlagen ist — nicht, dass der Browserabruf oder SomaFM keinen Titel bereitstellt.

| `code` | Bedeutung |
| --- | --- |
| `UPSTREAM_HTTP` | SomaFM hat einen HTTP-Fehler zurückgegeben; `upstreamStatus` enthält den Status, wenn vorhanden. |
| `INVALID_RESPONSE` | Die Antwort war kein lesbares oder gültiges JSON mit Groove-Salad-Daten. |
| `MISSING_TRACK` | Es liegen derzeit keine vollständigen Songdaten vor. |
| `TIMEOUT` | Der Abruf wurde nach fünf Sekunden abgebrochen oder eine Verbindungszeitüberschreitung trat auf. |
| `DNS_ERROR` | Der Hostname konnte nicht aufgelöst werden. |
| `TLS_ERROR` | Die Zertifikatsprüfung der Verbindung ist fehlgeschlagen. |
| `NETWORK_ERROR` | Ein anderer Netzwerkfehler ist aufgetreten. |

Die Fehlerantwort enthält keine rohen Fehlermeldungen oder Proxy-Adressen. Nach einem App-Update lade die Seite im Browser neu (unter Windows bei Bedarf mit `Ctrl+F5`). Ein Serverneustart ist dafür nicht erforderlich; starte ihn nur neu, wenn sich Servercode oder dessen Konfiguration geändert hat. Node.js mindestens 24.14.0 bleibt erforderlich, da der optionale Server-Diagnose-Endpunkt weiterhin vorhanden ist.

### Musik und Hintergrund-Tabs

Timer und Oberfläche funktionieren ohne Musikverbindung weiter. Die Musik ist ein Live-Stream, keine gespeicherte Playlist. Sie benötigt eine Internetverbindung; nach einer Pause wird die aktuelle Live-Sendung neu verbunden. Browser können automatische Audiowiedergabe blockieren. Nutze dann die Schaltfläche zum manuellen Wiederverbinden.

Der Timer gleicht Zeitpunkte bei Rückkehr zum Tab ab und pausiert nicht, wenn der Tab verborgen ist. Eingefrorene Tabs und Windows-Ruhezustand können Anzeige- und Audiowechsel verzögern; nach Rückkehr wird die verstrichene Zeit nachgerechnet. Ein manuelles Abspielen des Streams in einem aktuellen Edge- oder Chrome-Browser kann die Verbindung prüfen. Eine solche Browser- oder Streamprüfung wird hier nicht als bereits durchgeführt behauptet.
