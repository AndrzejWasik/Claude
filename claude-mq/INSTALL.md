# Instalacja na kolejnej maszynie

Sa dwie sytuacje i roznia sie tym, ile trzeba zrobic:

- **A. Maszyna, na ktorej wtyczki jeszcze nie ma** - trzeba zalozyc konfiguracje
  magistrali, wiec dane brokera sa potrzebne.
- **B. Maszyna, na ktorej stoi starsza wersja** - konfiguracja juz jest i nie
  wolno jej ruszac. Wystarczy przepiac na nowy katalog.

W obu wypadkach nic nie trzeba przygotowywac na brokerze: kolejki i powiazania
powstaja same przy pierwszym polaczeniu.

---

## Wymagania

| co | jak sprawdzic |
|---|---|
| Node 20 lub nowszy | `node --version` |
| git | `git --version` |
| Claude Code | uruchamia sie |
| dostep do brokera | `Test-NetConnection broker.twoja-siec.local -Port 7680` |

Jesli `node --version` nie dziala, pobierz Node z <https://nodejs.org/en/download>,
zainstaluj i **otworz nowe okno konsoli** - stare maja stary PATH.

Krok z `npm install` wymaga dostepu do rejestru npm. Gdy go nie ma, patrz
"Maszyna bez dostepu do npm" na koncu.

---

## A. Instalacja od zera

### 1. Sklonuj repozytorium

Wybierz miejsce, z ktorego katalog **nie bedzie przenoszony** - instalator
zapisuje sciezki na sztywno.

```powershell
git clone https://github.com/AndrzejWasik/Claude.git C:\Code\miramar\web\Claude
```

Projekt lezy w podkatalogu, nie w korzeniu:

```powershell
cd C:\Code\miramar\web\Claude\claude-mq
```

### 2. Zaleznosci

```powershell
npm install
```

### 3. Konfiguracja i wpiecie

Dane brokera podaje sie tutaj - w repozytorium ich nie ma i nie bedzie.

```powershell
node setup.mjs --url stomp://broker.twoja-siec.local:7680 --vhost CLAUDE --login CLAUDE --passcode HASLO --peer dev-d13
```

`--peer` to nazwa maszyny, z ktora ta ma rozmawiac. Nazwa tej sesji na magistrali
to domyslnie nazwa hosta; wlasna ustawia `--name`. Pelna liste opcji pokazuje
`node setup.mjs --help`.

Instalator przechodzi piec krokow i po kazdym pisze, co zrobil: sprawdza Node,
sprawdza zaleznosci, zapisuje konfiguracje magistrali, wpina serwer MCP i hooki
do Claude Code, na koniec laczy sie z brokerem i wypisuje stan.

### 4. Restart Claude Code

Serwer i hooki ladowane sa przy starcie sesji.

### 5. Domkniecie polaczenia

W trybie `pair` **obie strony musza znac sie po nazwie**. Instalator wypisuje na
koncu nazwe, ktora nadal tej maszynie. Te nazwe trzeba dopisac po drugiej stronie
w `~/.claude/mq/config.json`:

```json
"peers": ["nazwa-tej-maszyny"]
```

Dopiero wtedy ruch idzie w obie strony.

---

## B. Aktualizacja istniejacej instalacji

Nie nadpisuj starego katalogu. Sklonuj **obok** i przepnij - stara kopia
przestanie cokolwiek obslugiwac, a w razie czego wracasz jednym poleceniem.

### 1. Klon obok

```powershell
git clone https://github.com/AndrzejWasik/Claude.git C:\Code\miramar\web\Claude
```

```powershell
cd C:\Code\miramar\web\Claude\claude-mq
```

### 2. Zaleznosci

```powershell
npm install
```

### 3. Przepiecie

Podglad bez zapisu:

```powershell
node install.mjs --dry-run
```

Wlasciwe przepiecie:

```powershell
node install.mjs
```

**Konfiguracji magistrali to nie dotyka.** Nazwa, broker, haslo i lista
rozmowcow zostaja, jakie byly. Zmienia sie wylacznie sciezka, spod ktorej
Claude Code uruchamia serwer i hooki.

### 4. Restart Claude Code

### 5. Dopiero teraz skasuj stara kopie

```powershell
Remove-Item -Recurse -Force C:\stara\sciezka\claude-mq
```

**Nie wczesniej.** Dopoki sesja zyje, proces serwera trzyma swoj katalog i
Windows odmawia jego usuniecia - dostaniesz "Device or resource busy". Uchwyt
potrafi zostac jeszcze chwile po zamknieciu sesji; wtedy wystarczy powtorzyc.

Dwie identyczne kopie bez sygnalu, ktora chodzi, to stan, w ktorym latwo przez
pol dnia czytac i poprawiac pliki, ktorych nikt nie wykonuje. Rozjezdzaja sie
dopiero przy pierwszej zmianie i wtedy juz nic sie nie zgadza.

---

## Sprawdzenie, ze dziala

```powershell
node test\live.mjs
```

Sprawdza wpiecie serwera i hookow, startuje serwer z prawdziwa konfiguracja,
laczy sie z brokerem i wypisuje, kto jest na magistrali. Ma pokazac wersje 0.2.0
i sciezke, z ktorej faktycznie chodzi.

Sama magistrala:

```powershell
node bin\mq.mjs peers
```

Ma wymienic druga sesje razem z jej wersja. Rozmowca sprzed 0.1.2 nie wysyla
pola `app` i pokaze sie jako "sprzed 0.1.2" - to nie usterka, tylko brak tego
pola w starszym kodzie.

Proba przeslania:

```powershell
node bin\mq.mjs send dev-d13 "test z drugiej maszyny"
```

---

## Nastepne aktualizacje

Gdy katalog juz jest wpiety, aktualizacja to samo pobranie zmian:

```powershell
git pull
```

```powershell
npm install
```

Restart Claude Code. `install.mjs` uruchamia sie ponownie **tylko wtedy**, gdy
katalog zmienil miejsce - sciezki w konfiguracji Claude Code sa te same.

---

## Co instalator dotyka

| plik | co tam trafia |
|---|---|
| `~/.claude/mq/config.json` | adres brokera, dane logowania, nazwa sesji, lista rozmowcow (tylko w A) |
| `~/.claude.json` | wpis `mcpServers."claude-mq"` |
| `~/.claude/settings.json` | trzy hooki: `SessionStart`, `UserPromptSubmit`, `Stop` |

Kazdy z tych plikow dostaje kopie zapasowa z sufiksem `.bak-claude-mq`, zanim
cokolwiek zostanie zapisane. Instalator dokleja sie do tego, co juz jest -
istniejace serwery MCP i cudze hooki zostaja nietkniete.

`config.json` trzyma haslo do brokera otwartym tekstem. W repozytorium hasla nie
ma i nie powinno sie tam znalezc.

---

## Odinstalowanie

```powershell
node install.mjs --remove
```

Zdejmuje serwer MCP i hooki, reszte konfiguracji zostawia. `~/.claude/mq/`
kasuje sie osobno, jesli ma zniknac takze zapis rozmow.

---

## Maszyna bez dostepu do npm

Zaleznosci nie zmienily sie od pierwszej wersji, wiec zamiast `npm install`
wystarczy przeniesc katalog `node_modules` z dowolnej dzialajacej kopii.

Alternatywa: `node pack.mjs` na maszynie, ktora ma dostep - buduje w `dist/`
paczke zip z zaleznosciami w srodku, gotowa do rozpakowania gdzie indziej.
Paczka domyslnie **nie zawiera** hasla do brokera; podaje sie je flagami przy
`setup.mjs`.

---

## Kiedy nie dziala

**`node` albo `git` nie znalezione** - otworz nowe okno konsoli po instalacji;
stare maja stary PATH.

**`broker ... BLAD: timeout polaczenia`** - z tej maszyny nie widac portu.
Sprawdz `Test-NetConnection <host> -Port <port>`. Broker przyjmuje polaczenia
wychodzace, wiec przekierowanie portow nie jest potrzebne - problem lezy po
stronie zapory albo DNS.

**`BLAD z brokera: ACCESS_REFUSED`** - zle haslo albo vhost. Sprawdz
`~/.claude/mq/config.json`.

**`mq_peers` pusty, a `whoami` pokazuje OK** - druga strona nie ma uruchomionej
sesji albo siedzi na innym vhoscie. Obecnosc widzi tylko sesje faktycznie zywe.

**Wiadomosci nie dochodza, a `peers` pokazuje obie sesje** - w trybie `pair`
z nazewnictwem kolejek od nadawcy jedna kolejke moze czytac tylko jeden odbiorca.
Sprawdz, czy nie chodzi rownolegle `mq listen` albo druga sesja o tej samej
nazwie - zabiora czesc ruchu. Trzy i wiecej sesji wymagaja
`"queueNaming": "recipient"` albo `"mode": "mesh"`.

**Wiadomosci dochodza z opoznieniem** - to nie usterka. Sesja odbiera poczte na
poczatku tury i przy jej zakonczeniu, nie w srodku dlugiej pracy. Zeby czekala
na poczte przed zakonczeniem tury, ustaw `"waitOnStopMs": 30000`.

**Zmiana w kodzie nie daje zadnego skutku** - najpewniej chodzi inna kopia niz
ta, ktora edytujesz. Ktora jest podpieta, mowia dwa wpisy:

```powershell
node -e "const c=require(require('os').homedir()+'/.claude.json');console.log(c.mcpServers['claude-mq'].args[0])"
```

```powershell
node -e "const c=require(require('os').homedir()+'/.claude/settings.json');console.log(JSON.stringify(c.hooks,null,1))"
```

Sciezka z pierwszego polecenia to kopia, ktora naprawde obsluguje sesje.
