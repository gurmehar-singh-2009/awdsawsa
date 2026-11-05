#!/bin/sh
# Two real peers over public Nostr signalling + WebRTC; checks hello, host election, events, snapshots.
ROOM="test-$(date +%s)"
npx tsx tests/p2p-peer.ts "$ROOM" A 0 & npx tsx tests/p2p-peer.ts "$ROOM" B 1500 & wait
