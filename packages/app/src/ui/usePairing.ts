/**
 * Pairing, as state: check a scanned code, prove it with a real handshake,
 * then hand the pairing over. The screen only draws it. Scanning is the only
 * way in: a pasted link put the pairing secret in the clipboard and in
 * screenshots of the computer it was copied from.
 *
 * Shape is not proof: a retired token parses exactly like a live one, so a
 * link is stored only after `verifyPairing` completes a handshake (a 401 from
 * the daemon or 409 from the relay both happen below the WebSocket).
 */
import { useState } from "react";
import { haptics } from "./haptics";
import { parsePairing, type Pairing } from "../pairingLink";
import { deviceId } from "../pairing";
import { verifyPairing } from "../verifyPairing";
import type { HandshakePhase } from "./Handshake";

/** How long the green wire is held after a pairing lands, so it is seen. */
const PAIRED_HOLD_MS = 900;

export function usePairing(onPaired: (pairing: Pairing) => void) {
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<HandshakePhase>("waiting");
  const [machine, setMachine] = useState<string | null>(null);

  const accept = async (value: string): Promise<string | null> => {
    setPhase("pairing");
    const result = parsePairing(value, await deviceId());
    if (!result.ok) {
      setPhase("failed");
      return result.error;
    }
    const verified = await verifyPairing(result.pairing);
    if (!verified.ok) {
      setPhase("failed");
      return verified.message;
    }
    setMachine(result.pairing.label);
    setPhase("paired");
    const pairing = result.pairing;
    setTimeout(() => onPaired(pairing), PAIRED_HOLD_MS);
    return null;
  };

  /** A scanned code: stays on the camera with the reason if it fails. */
  const scanned = async (value: string) => {
    setBusy(true);
    const failure = await accept(value);
    setBusy(false);
    if (!failure) {
      setScanning(false);
      haptics.finished();
      return;
    }
    haptics.failed();
    setScanError(failure);
  };

  const openScanner = () => {
    setScanError(null);
    setScanning(true);
  };

  const closeScanner = () => {
    setScanning(false);
    if (scanError) setError(scanError);
    setScanError(null);
  };

  return { error, scanError, scanning, busy, phase, machine, scanned, openScanner, closeScanner };
}
