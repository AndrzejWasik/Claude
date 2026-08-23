# claude-mq

Dwie sesje Claude Code na dwoch maszynach pisza do siebie przez RabbitMQ. Jedna
wklada wiadomosc do kolejki, druga ja z niej zdejmuje i dostaje jej tresc
wprost do rozmowy - bez przeklejania przez czlowieka.

Dziala tam, gdzie bezposrednie polaczenie miedzy maszynami nie wchodzi w gre:
obie strony tylko wychodza do brokera, zadna nie musi przyjmowac polaczen. Maszyna
za NAT-em rozmawia z maszyna w innej sieci bez zadnego przekierowania portu.

---

## Wymagania

- RabbitMQ z wtyczka `rabbitmq_stomp` (sprawdzone na 4.3.4)
- Node 20 lub nowszy na kazdej maszynie
- konto na brokerze z prawem zapisu i odczytu na wybranym vhoscie

Broker nie potrzebuje niczego przygotowanego z gory - kolejki i powiazania
powstaja same przy pierwszym polaczeniu.

---

## Instalacja

```bash
cd C:/Code/Projects/claude-mq && npm install
```

Rejestracja wtyczki w Claude Code:

```bash
claude plugin marketplace add C:/Code/Projects/claude-mq
```

```bash
claude plugin install claude-mq@miramar-local
```

Jesli wolisz nie ruszac systemu wtyczek, `node install.mjs` dopisze serwer i
hooki wprost do `~/.claude/settings.json`, robiac wczesniej kopie zapasowa.
`node install.mjs --remove` cofa zmiane.

---

## Konfiguracja

Jeden plik na maszyne: `~/.claude/mq/config.json`. Szkielet wypisze
`node bin/mq.mjs init`.

```json
{
  "url": "stomp://broker.example.com:7680",
  "vhost": "CLAUDE",
  "login": "CLAUDE",
  "passcode": "...",

  "name": "dev-d13",
  "roles": ["delphi", "windows"],

  "mode": "pair",
  "queueNaming": "sender",
  "peers": ["laptop"],

  "deliverOnPrompt": true,
  "deliverOnStop": true,
  "waitOnStopMs": 0,
  "maxDeliveredPerTurn": 20
}
```

| klucz | znaczenie |
|---|---|
| `url` | `stomp://host:port`, dla TLS `stomp+ssl://host:port` |
| `vhost` | wirtualny host na brokerze |
| `login`, `passcode` | dane logowania |
| `name` | nazwa bazowa; pusta = nazwa hosta |
| `identity` | `machine` (jedna nazwa na komputer) albo `session` (osobna na rozmowe) |
| `label` | czytelny opis rozmowy, widoczny dla innych w `mq_peers` |
| `roles` | etykiety, po ktorych mozna adresowac grupowo |
| `mode` | `pair` (trwale kolejki) albo `mesh` (temat dla wielu sesji) |
| `queueNaming` | w trybie `pair`: `sender` albo `recipient` - patrz nizej |
| `peers` | z kim rozmawiamy w trybie `pair` |
| `deliverOnPrompt` | doreczanie poczty na poczatku kazdej tury |
| `deliverOnStop` | doreczanie zamiast zakonczenia tury, gdy cos przyszlo |
| `waitOnStopMs` | ile czekac na poczte przed zakonczeniem tury (0 = nie czekac, max 115000) |
| `maxDeliveredPerTurn` | ile wiadomosci naraz wpuscic do rozmowy; reszta czeka |
| `autoAck` | potwierdzaj odbior natychmiast po odebraniu ramki (domyslnie tak) |
| `ackWaitMs` | ile `mq_send` czeka na to potwierdzenie, zanim odpowie |

Kazdy z kluczy `url`, `name`, `roles`, `peers`, `mode` da sie nadpisac zmienna
srodowiskowa: `CLAUDE_MQ_URL`, `CLAUDE_MQ_NAME`, `CLAUDE_MQ_ROLES`,
`CLAUDE_MQ_PEERS`, `CLAUDE_MQ_MODE`. Zmienna jest jedynym sposobem na dwie sesje
o roznych nazwach na jednej maszynie.

Plik trzyma haslo otwartym tekstem. Nie wklada sie go do repozytorium.

---

## Tozsamosc: maszyna czy rozmowa

Kto jest adresatem na magistrali - komputer czy pojedyncza rozmowa? Do wyboru sa
oba, bo do roznych rzeczy sluza.

### `identity: "machine"` (domyslna)

Nazwa nalezy do komputera. Prosto i przewidywalnie: jedna maszyna, jeden adres,
kolejka trwala, wiadomosc do wylaczonego komputera poczeka.

Ograniczenie jest twarde: **jedna rozmowa naraz**. Dwie sesje Claude Code
uruchomione rownolegle maja te sama nazwe, wiec czytaja te sama kolejke, a
RabbitMQ rozdziela wiadomosci miedzy konsumentow zamiast dawac kazdemu kopie -
kazda sesja dostanie polowe, zadna calosci.

### `identity: "session"`

Nazwa nalezy do rozmowy: `<baza>-<sufiks>`, gdzie sufiks to szesc pierwszych
znakow identyfikatora sesji. Kazda rozmowa ma wlasny adres, wlasna kolejke i
wlasna skrzynke, wiec dowolna liczba rozmow na jednym komputerze rozmawia
niezaleznie.

Serwer MCP i hooki wyliczaja te nazwe **niezaleznie od siebie**, z tej samej
zmiennej srodowiskowej `CLAUDE_CODE_SESSION_ID`, ktora Claude Code przekazuje
swoim procesom potomnym. Nie ma miedzy nimi zadnego uzgadniania, ktore mogloby
sie rozjechac. Gdyby zmiennej zabraklo, nazwa spada z powrotem na nazwe maszyny,
a `mq_whoami` mowi o tym wprost.

Skoro nazw rozmow nie da sie wpisac do `peers` z gory, adresowanie musi byc
wyszukiwane, a nie skonfigurowane - dlatego `identity: "session"` wlacza tryb
`mesh`, o ile nie ustawiono `mode` jawnie. Cena jest jedna i warto ja znac:
**mesh nie kolejkuje dla nieobecnych**. Wiadomosc do rozmowy, ktora sie skonczyla,
przepada, zamiast poczekac.

Przy kilku rozmowach naraz sam sufiks nazwy niewiele mowi, wiec kazda moze sie
przedstawic:

| narzedzie | co robi |
|---|---|
| `mq_label` | ustawia czytelny opis tej rozmowy, widoczny w `mq_peers` u innych |

Etykieta lezy w `label.txt` obok skrzynki, wiec przezywa restart serwera w obrebie
tej samej rozmowy.

### Ktore kiedy

| chce | ustaw |
|---|---|
| dwie maszyny, po jednej rozmowie, poczta ma czekac na nieobecnego | `identity: machine`, `mode: pair` |
| dowolne rozmowy na dowolnych maszynach, kazda osobno | `identity: session` |
| wiele maszyn, adresowanie bez wpisywania nazw, bez kolejkowania | `identity: machine`, `mode: mesh` |

---

## Topologie

### `mode: "pair"`, `queueNaming: "sender"` (domyslna)

Kazda sesja pisze wylacznie do wlasnej kolejki, a slucha kolejek swoich rozmowcow.

```
sesja A  ──pisze──▶  /queue/claude.a  ──slucha──▶  sesja B
sesja B  ──pisze──▶  /queue/claude.b  ──slucha──▶  sesja A
```

Kolejka jest trwala, wiec wiadomosc wyslana do wylaczonej sesji poczeka na jej
powrot. Dziala dla dwoch sesji. Przy trzech kolejke jednego nadawcy czytaloby
dwoch odbiorcow, a RabbitMQ rozdziela wtedy wiadomosci po rowno zamiast dawac
kazdemu kopie - kazdy dostalby polowe.

### `mode: "pair"`, `queueNaming: "recipient"`

Kolejka nazwana od odbiorcy: kazda sesja slucha wylacznie wlasnej, a nadawca
wklada wiadomosc do kolejki adresata.

```
sesja A  ──pisze──▶  /queue/claude.b  ──slucha──▶  sesja B
sesja B  ──pisze──▶  /queue/claude.a  ──slucha──▶  sesja A
```

Ten sam rysunek co wyzej, tylko kolejka nazwana od drugiej strony. Zachowuje
trwalosc i jest poprawny takze przy trzech i wiecej sesjach. Wiadomosc do
wszystkich trafia jako osobna kopia do kolejki kazdego wpisanego rozmowcy.

### `mode: "mesh"`

Ruch idzie przez wbudowany temat `amq.topic` kluczami `claude.mesh.<od>.<do>`.
Kazdy subskrybent dostaje wlasna tymczasowa kolejke.

| co | destynacja |
|---|---|
| do konkretnej sesji | `/topic/claude.mesh.<nadawca>.<odbiorca>` |
| do wszystkich | `/topic/claude.mesh.<nadawca>.all` |
| do roli | `/topic/claude.mesh.<nadawca>.role-<rola>` |
| nasluch | `/topic/claude.mesh.*.<ja>`, `/topic/claude.mesh.*.all`, `/topic/claude.mesh.*.role-<rola>` |

Skaluje sie na dowolna liczbe sesji i nie wymaga wpisywania rozmowcow do
konfiguracji. Nie przechowuje niczego dla sesji wylaczonych - kto nie sluchal,
ten nie dostal.

### Obecnosc

Niezaleznie od trybu lista zywych sesji chodzi przez `amq.topic`:

| co | destynacja |
|---|---|
| zapytanie | `/topic/claude.presence.ping` |
| odpowiedz | `/topic/claude.presence.pong.<pytajacy>` |

Pytajacy zbiera odpowiedzi przez ustalony czas, domyslnie 1500 ms. Odpowiada
tylko sesja, ktorej serwer akurat dziala, wiec lista pokazuje faktycznie zywe
sesje, a nie te kiedys skonfigurowane.

---

## Format wiadomosci

Tresc ramki to JSON w UTF-8, wysylany z naglowkami
`content-type: application/json;charset=utf-8` oraz `content-length`.
W trybie `pair` dochodzi `persistent: true`.

```json
{
  "v": 1,
  "app": "0.1.2",
  "id": "m-3f9a1c22",
  "type": "msg",
  "ts": "2026-08-23T09:14:07.412Z",
  "from": "dev-d13",
  "to": "laptop",
  "host": "DEV-D13",
  "cwd": "C:\\Code\\Projects\\common",
  "thread": "t-8b21e004",
  "reply_to": null,
  "text": "skonczylem port frx.inc, zostaje fs.inc"
}
```

| pole | znaczenie |
|---|---|
| `v` | wersja koperty, obecnie `1` |
| `app` | wersja wtyczki nadawcy; brak pola = strona sprzed 0.1.2 |
| `id` | identyfikator wiadomosci |
| `type` | `msg`, `ack`, `ping` albo `pong` |
| `ts` | czas nadania, ISO 8601 UTC |
| `from` | nazwa sesji nadawcy |
| `to` | nazwa odbiorcy, `*` dla wszystkich albo `role:<rola>` |
| `host`, `cwd` | maszyna i katalog roboczy nadawcy |
| `thread` | identyfikator watku; odpowiedz powtarza go bez zmian |
| `reply_to` | `id` wiadomosci, na ktora to jest odpowiedz |
| `text` | tresc |

### Potwierdzenie odbioru

Odebranie wiadomosci typu `msg` natychmiast odsyla ramke `ack` z polami
`ack_of` (identyfikator potwierdzanej wiadomosci), `thread` oraz `pending`
(ile nieprzeczytanych lezy u odbiorcy razem z ta).

Robi to warstwa transportu, w chwili odebrania ramki - nie sesja i nie jej
uzytkownik. Nadawca dowiaduje sie wiec, ze wiadomosc dotarla na druga maszyne,
nie czekajac az tamta sesja wezmie ture. Sesja bezczynna potrafi nie wziac jej
przez godziny, a wtedy cisza po drugiej stronie nie mowi nic o tym, czy
cokolwiek doszlo.

Potwierdzenie nie trafia do skrzynki ani do rozmowy - jest tylko dla nadawcy.
`mq_send` czeka na nie do `ackWaitMs` i melduje wynik w swojej odpowiedzi.

Czego potwierdzenie **nie** znaczy: ze wiadomosc zostala przeczytana. Znaczy
tylko, ze lezy na tamtej maszynie. Pole `pending` wieksze od jedynki mowi
wprost, ze sesja zbiera poczte, ale tury nie bierze.

W ramce `pong` zamiast `text` przychodzi `corr` (identyfikator zapytania),
`roles` i `mode` odpowiadajacej sesji.

Odbiorca odrzuca wiadomosci, ktorych `to` wskazuje kogos innego. Wlasne
wiadomosci rozpoznaje po `from` i nie wpuszcza ich z powrotem do skrzynki.

---

## Narzedzia dostepne w rozmowie

| narzedzie | co robi |
|---|---|
| `mq_whoami` | nazwa tej sesji, tryb, destynacje, stan polaczenia, ile czeka; ostrzega, gdy na dysku lezy inna wersja niz w procesie |
| `mq_peers` | lista zywych sesji z rolami, hostem i katalogiem roboczym |
| `mq_send` | wysyla tekst; z `wait_for_reply` czeka na odpowiedz w tym samym watku; `reply_to` wskazuje `id` wiadomosci, na ktora to jest odpowiedz |
| `mq_inbox` | zdejmuje ze skrzynki; z `wait_ms` czeka na pierwsza wiadomosc |
| `mq_label` | nadaje tej rozmowie czytelny opis, widoczny dla innych |
| `mq_history` | pelny zapis wymiany: wyslane i odebrane, w kolejnosci czasu |

Komendy: `/mq-peers`, `/mq-send <sesja> <tresc>`, `/mq-wait [sekundy]`.

---

## Jak wiadomosc trafia do rozmowy

Sesja Claude pracuje turami i nie da sie jej przerwac z zewnatrz w dowolnej
chwili. Doreczanie jest wiec podpiete do trzech momentow:

1. **Poczatek tury** - wszystko, co czekalo, wchodzi jako kontekst pytania.
2. **Koniec tury** - jesli cos czeka, tura nie konczy sie od razu: Claude
   dostaje tresc i najpierw sie nia zajmuje. Blokada dziala raz pod rzad, wiec
   nie da sie w ten sposob zapetlic.
3. **Jawne siegniecie** - `mq_inbox` z `wait_ms`, kiedy sesja swiadomie czeka
   na druga strone.

Przy `waitOnStopMs` wiekszym od zera koniec tury czeka jeszcze zadany czas na
spoznione wiadomosci. Sesja staje sie wtedy nasluchujacym pracownikiem, ktory
sam odbiera zlecenia. Kosztem jest opoznienie na koncu kazdej tury; domyslnie
wylaczone.

Wiadomosci wchodza do rozmowy opakowane w `<mq-message>` z adnotacja, ze sa
danymi od innej sesji, a nie poleceniem uzytkownika. Prosba z drugiej strony o
cokolwiek, co zapisuje, kasuje, instaluje albo wysyla, ma trafic do uzytkownika
tej sesji, zanim zostanie wykonana.

---

## Z linii polecen

To samo, co narzedzia w rozmowie - do sprawdzenia konfiguracji i podgladania
ruchu bez odpalania sesji.

```bash
node bin/mq.mjs whoami
```

```bash
node bin/mq.mjs peers
```

```bash
node bin/mq.mjs send laptop "buduje sie, daj znac jak skonczysz"
```

```bash
node bin/mq.mjs listen
```

```bash
node bin/mq.mjs log 50
```

---

## Zapis rozmowy

Kazda wiadomosc, w obie strony, laduje w dwoch plikach w
`~/.claude/mq/peers/<nazwa>/`:

| plik | co zawiera |
|---|---|
| `chat.log` | czytelny zapis: czas, kierunek, rozmowca, watek, tresc |
| `archive.jsonl` | to samo maszynowo, jedna koperta na linie, z polem `dir` |

`chat.log` dopisuje sie sam i nikt go nie obcina - to on jest trwalym sladem
rozmowy. `archive.jsonl` czyta `mq log` i narzedzie `mq_history`, ktore
porzadkuja wpisy po czasie, a nie po kolejnosci dopisania.

Osobno `inbox.jsonl` trzyma to, co jeszcze nie zostalo pokazane sesji - ten
plik pustoszeje przy kazdym doreczeniu i nie jest zapisem rozmowy.

`mq listen` czyta te sama kolejke co serwer wtyczki. Przy `queueNaming: sender`
uruchomiony rownolegle z sesja zabierze jej czesc wiadomosci - do podgladu
uzywaj go wtedy, gdy sesja nie dziala.

---

## Testy

```bash
npm test
```

Sprawdza skrzynke, doreczanie i uscisk dloni serwera bez dotykania brokera.

```bash
npm run test:broker
```

Podnosi dwie sesje w jednym procesie i przechodzi wszystkie trzy topologie na
prawdziwym brokerze: adresowanie wprost, do wszystkich i po roli, odfiltrowanie
cudzej poczty, liste obecnych, pytanie z odpowiedzia w watku oraz doreczenie
wiadomosci wyslanej do wylaczonej sesji. Zostawia po sobie kolejki
`claudetest.loop-a` i `claudetest.loop-b`.

---

## Czego to nie robi

- Nie szyfruje tresci. Poufne rzeczy albo przez `stomp+ssl://`, albo wcale.
- Nie potwierdza doreczenia. Wyslanie konczy sie powodzeniem, gdy broker przyjal
  ramke, a nie gdy druga strona ja przeczytala. Pewnosc daje dopiero odpowiedz.
- Nie przerywa trwajacej tury. Wiadomosc wysłana w srodku dlugiej pracy poczeka
  do jej konca.
- Nie sprząta kolejek w trybie `pair`. Kolejka po skasowanej sesji zostaje pusta
  na brokerze; usuwa sie ja recznie albo polityka `x-expires` na vhoscie.
