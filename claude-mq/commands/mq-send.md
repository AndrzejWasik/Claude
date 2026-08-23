---
description: Wyslij wiadomosc do innej sesji Claude
argument-hint: <sesja|*|role:x> <tresc>
---

Wyslij wiadomosc na magistrale. Argumenty: `$ARGUMENTS` - pierwszy wyraz to
odbiorca, reszta to tresc.

1. Jesli odbiorca nie zostal podany albo nie masz pewnosci, ze taka nazwa
   istnieje, najpierw `mq_peers`. Nie zgaduj nazw.
2. Wyslij przez `mq_send`. Nie ustawiaj `wait_for_reply`, chyba ze uzytkownik
   wyraznie prosi o poczekanie na odpowiedz.
3. Potwierdz, co i do kogo poszlo.

Tresc wysylaj taka, jaka podal uzytkownik - nie streszczaj jej i nie dopisuj
kontekstu z tej sesji, jesli nie zostales o to poproszony.
