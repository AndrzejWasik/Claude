# Instalacja na drugiej maszynie

Paczka jest samowystarczalna: ma w sobie wszystkie zaleznosci, wiec instalacja
nie potrzebuje dostepu do npm. Potrzebny jest tylko Node i widocznosc brokera.

---

## Wymagania

| co | jak sprawdzic |
|---|---|
| Node 20 lub nowszy | `node --version` |
| Claude Code na tej maszynie | uruchamia sie |
| dostep do brokera | `Test-NetConnection broker.twoja-siec.local -Port 7680` |

Jesli `node --version` nie dziala, pobierz Node z <https://nodejs.org/en/download>,
zainstaluj i otworz nowe okno konsoli.

---

## Instalacja

### 1. Rozpakuj

Rozpakuj `claude-mq-<wersja>.zip` w miejsce, z ktorego katalog **nie bedzie
przenoszony** - instalator zapisuje sciezki na sztywno. Sensownie:

```
C:\Code\Projects\claude-mq
```

Jesli paczka przyszla przez siec i Windows ja zablokowal, odblokuj przed
rozpakowaniem:

```powershell
Unblock-File C:\sciezka\do\claude-mq-<wersja>.zip
```

### 2. Uruchom instalator

Paczka nie zawiera hasla do brokera - podaje sie je przy instalacji:

```powershell
.\setup.cmd --url stomp://broker.twoja-siec.local:7680 --vhost CLAUDE --login CLAUDE --passcode HASLO --peer dev-d13
```

`--peer` to nazwa maszyny, z ktora ta ma rozmawiac. Nazwa tej sesji na
magistrali to domyslnie nazwa hosta; wlasna ustawia `--name laptop`.

Jesli instalacja ma isc na wiecej niz jednej maszynie, wygodniej wpisac dane
brokera raz do pliku `broker.json` obok `setup.cmd`:

```json
{
  "url": "stomp://broker.twoja-siec.local:7680",
  "vhost": "CLAUDE",
  "login": "CLAUDE",
  "passcode": "HASLO"
}
```

Wtedy wystarczy `.\setup.cmd --peer dev-d13`, a `broker.json` kasuje sie po
instalacji - haslo jest juz w konfiguracji magistrali.

Instalator przechodzi piec krokow i po kazdym pisze, co zrobil: sprawdza Node,
sprawdza zaleznosci, zapisuje konfiguracje magistrali, wpina serwer i hooki do
Claude Code, a na koniec laczy sie z brokerem i wypisuje stan.

Pelna liste opcji pokazuje `.\setup.cmd --help`.

### 3. Zrestartuj Claude Code

Serwer i hooki ladowane sa przy starcie sesji.

---

## Co instalator dotyka

| plik | co tam trafia |
|---|---|
| `~/.claude/mq/config.json` | adres brokera, dane logowania, nazwa sesji, lista rozmowcow |
| `~/.claude.json` | wpis `mcpServers."claude-mq"` |
| `~/.claude/settings.json` | trzy hooki: `SessionStart`, `UserPromptSubmit`, `Stop` |

Kazdy z tych plikow dostaje wczesniej kopie zapasowa z sufiksem `.bak-claude-mq`.
Instalator dokleja sie do tego, co juz jest - istniejace serwery MCP i cudze
hooki zostaja nietkniete.

`config.json` trzyma haslo do brokera otwartym tekstem. Paczka instalacyjna go
nie zawiera, chyba ze zostala zbudowana z `--with-credentials`.

---

## Domkniecie polaczenia

Tryb `pair` wymaga, zeby **obie strony znaly sie po nazwie**. Instalator na
koncu wypisuje nazwe, ktora nadal tej maszynie. Te nazwe trzeba dopisac po
drugiej stronie w `~/.claude/mq/config.json`:

```json
"peers": ["nazwa-tej-maszyny"]
```

Dopiero wtedy ruch idzie w obie strony. Sama zmiana pliku wystarczy - kolejny
start sesji ja podniesie.

Alternatywa bez wpisywania nazw: `--mode mesh` po obu stronach. Sesje znajduja
sie wtedy same, kosztem tego, ze wiadomosc do wylaczonej sesji przepada zamiast
poczekac w kolejce.

---

## Sprawdzenie, ze dziala

Na tej maszynie:

```powershell
node bin\mq.mjs whoami
```

Ma pokazac `broker ... OK` oraz kolejke, do ktorej pisze.

Z obu maszyn naraz, przy uruchomionych sesjach Claude:

```powershell
node bin\mq.mjs peers
```

Ma wymienic te druga sesje. Jesli lista jest pusta, a `whoami` pokazuje OK, to
znaczy, ze druga strona nie ma uruchomionej sesji albo siedzi na innym vhoscie.

Proba przeslania:

```powershell
node bin\mq.mjs send dev-d13 "test z drugiej maszyny"
```

W sesji Claude na maszynie docelowej wiadomosc pojawi sie na poczatku
nastepnej tury albo zamiast jej zakonczenia.

---

## Odinstalowanie

```powershell
node install.mjs --remove
```

Zdejmuje serwer MCP i hooki, zostawiajac reszte konfiguracji. `~/.claude/mq/`
trzeba skasowac osobno, jesli ma zniknac takze historia wiadomosci.

---

## Kiedy nie dziala

**`setup.cmd` zamyka sie od razu** - Node nie jest w PATH. Otworz nowe okno
konsoli po instalacji Node; stare okna maja stary PATH.

**`broker ... BLAD: timeout polaczenia`** - z tej maszyny nie widac portu 7680.
Sprawdz `Test-NetConnection broker.twoja-siec.local -Port 7680`. Broker
przyjmuje polaczenia wychodzace, wiec przekierowanie portow nie jest potrzebne -
problem jest po stronie zapory albo DNS.

**`BLAD z brokera: ACCESS_REFUSED`** - zle haslo albo vhost. Sprawdz
`~/.claude/mq/config.json`.

**Wiadomosci nie dochodza, a `peers` pokazuje obie sesje** - w trybie `pair`
z domyslnym nazewnictwem kolejek jedna kolejke moze czytac tylko jeden odbiorca.
Sprawdz, czy gdzies nie chodzi rownolegle `mq listen` albo druga sesja o tej
samej nazwie - zabiora czesc ruchu. Trzy i wiecej sesji wymagaja
`"queueNaming": "recipient"` albo `"mode": "mesh"`.

**Wiadomosci dochodza z opoznieniem** - to nie usterka. Sesja odbiera poczte na
poczatku tury i przy jej zakonczeniu, a nie w srodku dlugiej pracy. Zeby sesja
czekala na poczte przed zakonczeniem tury, ustaw w `config.json`
`"waitOnStopMs": 30000`.

**Hooki nie odpalaja sie** - sprawdz, czy `~/.claude/settings.json` jest
poprawnym JSON-em i czy Claude Code byl restartowany po instalacji.

**Zmiana w kodzie nie daje zadnego skutku** - najpewniej na dysku sa dwie kopie
paczki, a uruchomiona jest ta druga. Duplikaty sa milczace: dopoki pliki sa
identyczne, nic nie zgrzyta, a numery linii zgadzaja sie w obu. Rozjezdzaja sie
dopiero przy pierwszej aktualizacji jednej z nich. Ktora kopia chodzi, mowia dwa
wpisy:

```powershell
node -e "const c=require(require('os').homedir()+'/.claude.json');console.log(c.mcpServers['claude-mq'].args[0])"
```

```powershell
node -e "const c=require(require('os').homedir()+'/.claude/settings.json');console.log(JSON.stringify(c.hooks,null,1))"
```

Sciezka z pierwszego polecenia to kopia, ktora naprawde obsluguje sesje.
