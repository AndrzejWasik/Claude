# INTERNALS

Notatki z budowy. Co bolalo, czego nie robic drugi raz i dlaczego niektore
rzeczy wygladaja dziwnie.

## STOMP zamiast AMQP

Pierwsza wersja stala na `amqplib`. Skan portow brokera:

```
  7680  otwarty         STOMP
  5672  ECONNREFUSED    AMQP
  5671  ECONNREFUSED    AMQP/TLS
 61613  ECONNREFUSED    domyslny STOMP
 15672  otwarty         panel zarzadzania
 15674  ECONNREFUSED    STOMP po WebSocket
```

AMQP jest zamkniete, wiec caly transport poszedl na STOMP. Zmiana dotknela
tylko warstwy polaczenia - adresowanie, skrzynka i doreczanie zostaly bez zmian.

Skutkiem ubocznym jest to, ze nie da sie deklarowac wlasnych exchange'y: adapter
STOMP w RabbitMQ deklaruje kolejki, ale nie exchange, a `/exchange/<nazwa>`
wymaga, zeby exchange juz istnial. Stad tryb `mesh` chodzi po wbudowanym
`amq.topic` przez destynacje `/topic/...`, ktory istnieje zawsze. Sprawdzone -
wieloznaczniki `*` w kluczu subskrypcji dzialaja i nie przepuszczaja obcego ruchu.

## Wlasny kodek zamiast biblioteki

Odrzucone:

- `stompit` - jedyny utrzymywany klient STOMP po TCP dla Node, ostatnie wydanie
  z 2019.
- `@stomp/stompjs` - chodzi po WebSocket, a port 15674 jest zamkniety.

Caly protokol to okolo stu linii, wiec zostal napisany na miejscu. Dwie rzeczy,
o ktore latwo sie potknac:

- **Parsowanie po buforach, nie po stringach.** `content-length` liczy bajty, a
  tresci sa po polsku. Sklejanie chunkow w string i ciecie po znakach rozjezdza
  sie na pierwszym `ą`.
- **Heartbeaty to gole znaki nowej linii miedzy ramkami.** Parser musi je zjadac
  przed proba odczytania komendy, inaczej pierwszy heartbeat wyglada jak ramka
  o pustej nazwie i zrywa strumien.

Heartbeaty sa wlaczone (10 s w obie strony, broker sie zgadza). Bez nich
polaczenie trzymane godzinami przez NAT i firewall cichnie: gniazdo wyglada na
otwarte, a wiadomosci przestaja przychodzic.

## Skrzynka na dysku

Serwer MCP zyje tak dlugo jak sesja i to on trzyma polaczenie z brokerem. Hooki
sa osobnymi procesami odpalanymi na kazda ture - nie maja jak zajrzec do jego
pamieci. Wspolnym gruntem jest plik `inbox.jsonl` w `~/.claude/mq/peers/<nazwa>/`:
serwer dopisuje, hooki i narzedzia zdejmuja.

Stad blokada plikowa przez `open(..., 'wx')` z zajmowaniem zamka starszego niz
5 s. Bez tego rownolegly hook i `mq_inbox` potrafia zdjac ta sama wiadomosc dwa
razy albo zgubic ja przy nadpisaniu pliku.

Czekanie w blokadzie idzie przez `Atomics.wait` na `SharedArrayBuffer` - to
jedyny synchroniczny sposob na uspienie watku w Node, a caly kod skrzynki jest
synchroniczny, bo hooki musza sie wykonac i zakonczyc.

## Doreczanie na koncu tury

Hook `Stop` moze zablokowac zakonczenie tury i podac Claude'owi powod. Tak wchodzi
poczta, ktora przyszla, gdy uzytkownik nic nie pisal.

Pulapka: wejscie hooka niesie `stop_hook_active`. Jesli tura konczy sie po
blokadzie, flaga jest ustawiona i drugi raz blokowac nie wolno - inaczej sesja
kreci sie w kolko. Test `stop_hook_active nie blokuje drugi raz` pilnuje tego,
a wiadomosc zostaje w skrzynce na nastepna ture zamiast zniknac.

Limit `waitOnStopMs` stoi na 115 s, bo hook dostaje w `hooks.json` 120 s. Podnoszenie
jednego bez drugiego konczy sie ubiciem hooka w polowie czekania i cicha strata
tego, co wtedy przyszlo.

## Nazwy kolejek przy trzech sesjach

Model z zadania - A pisze do kolejki A, B slucha kolejki A - jest poprawny dla
dwoch sesji. Przy trzech kolejke A czytaja dwaj odbiorcy, a RabbitMQ rozdziela
wiadomosci miedzy konsumentow po rowno: kazdy dostaje polowe, nikt calosci.

Zamiast to ukrywac, wyszlo `queueNaming`. `sender` to model z zadania, `recipient`
odwraca nazewnictwo i zachowuje trwalosc kolejek przy dowolnej liczbie sesji.
Rozroznienie kosztuje jedna funkcje wyliczajaca destynacje.

Ten sam mechanizm gryzie `mq listen`: CLI dopisuje sie jako drugi konsument tej
samej kolejki co dzialajaca sesja i zabiera jej czesc wiadomosci. Nie da sie tego
obejsc inaczej niz nie uruchamiajac obu naraz albo przechodzac na `mesh`, gdzie
kazdy subskrybent ma wlasna kolejke.

## Argumenty kolejek

Pierwsza wersja ustawiala `x-expires` i `x-message-ttl` przy deklaracji. Kolejka,
ktora juz istnieje z innymi argumentami, konczy sie bledem PRECONDITION_FAILED,
a w AMQP dodatkowo ubija kanal - kazda zmiana konfiguracji wymagalaby recznego
kasowania kolejek na brokerze.

Zadne argumenty nie sa juz podawane. Czas zycia kolejek i wiadomosci ustawia sie
polityka na vhoscie, gdzie zmiana nie wywraca dzialajacych sesji.

## Zgubiony watek w wait_for_reply (0.1.1)

Wersja 0.1.0 przyjmowala `thread` w `mq_send`, ale przy `wait_for_reply` galaz
czekajaca w ogole go nie przekazywala dalej, a funkcja czekajaca bezwarunkowo
zakladala nowy watek. Skutek: dalo sie tylko **zaczac** rozmowe blokujacym
wywolaniem, nigdy jej kontynuowac - kazde pytanie z czekaniem tworzylo trzeci
watek obok istniejacego.

Znalazla to druga sesja podczas pierwszej prawdziwej rozmowy przez magistrale,
czytajac znaczniki watkow w naszej wlasnej wymianie: trzy identyfikatory na jedna
rozmowe. Blad byl niewidoczny w testach, bo caly ruch szedl przez galaz bez
czekania albo zaczynal nowy watek.

Przy okazji matcher przyjmuje teraz odpowiedz takze po `reply_to`, nie tylko po
watku - odpowiadajacy moze trafic dowolnym z dwoch i zgubiony `thread` po drugiej
stronie nie blokuje juz czekajacego. Regresja jest w suicie brokera i chodzi we
wszystkich trzech topologiach.

## Drobiazgi

- **Asercja libuv przy wyjsciu.** `process.exit()` wywolany zaraz po `fetch()`
  konczy sie na Windows `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
  i kodem 127 mimo zdanych testow. Test ustawia `process.exitCode` i pozwala
  Node'owi wyjsc samemu.
- **Panel zarzadzania oddaje 401.** Konto uzyte przez wtyczke nie ma tagu
  `management`, wiec sprzatanie kolejek testowych przez HTTP nie przechodzi.
  Kolejki `claudetest.loop-a` i `claudetest.loop-b` zostaja puste na brokerze.
- **Automatyczny przyrostek do nazwy zostal odrzucony.** Kusilo, zeby przy
  kolizji dopisywac `-2`, ale nazwe musza wyliczyc tak samo serwer i hooki, a
  hooki nie widza stanu serwera. Nazwa jest wiec deterministyczna, a dwie sesje
  na jednej maszynie rozroznia sie zmienna `CLAUDE_MQ_NAME`.
- **Serwer MCP nie moze pisac na stdout.** Tam idzie protokol. Cala diagnostyka
  leci na stderr.
- **Brak brokera nie wywala wtyczki.** Serwer wstaje, narzedzia odpowiadaja, a
  `mq_send` zwraca blad z powodem zamiast wisiec. Osobny test to sprawdza,
  celujac w martwy port.
