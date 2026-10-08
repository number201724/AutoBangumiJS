/**
 * WebAuthn service — 1:1 port of module/security/webauthn.py
 * (py_webauthn -> @simplewebauthn/server).
 *
 * Challenge store semantics are preserved exactly: keyed by base64url
 * challenge value, TTL 300s, cap 100 with oldest eviction; discoverable
 * authentication pops the challenge by the value the authenticator signed
 * (from clientDataJSON), not by position.
 */
import { Logger } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AuthenticatorTransport } from '@simplewebauthn/server';

import type { PasskeyRow } from '../database/schema';
import { ValueError } from '../common/errors';

const logger = new Logger('WebAuthnService');

const CHALLENGE_TTL_MS = 300 * 1000;
const CHALLENGE_MAX = 100;

interface ChallengeEntry {
  challenge: string; // base64url
  createdAt: number;
  logicalKey: string;
}

export interface VerifiedPasskey {
  credentialId: string; // base64url
  publicKey: string; // base64 (not url) — matches Python storage
  signCount: number;
  aaguid: string | null;
  backupEligible: boolean;
  backupState: boolean;
}

export class WebAuthnService {
  constructor(
    private readonly rpId: string,
    private readonly rpName: string,
    private readonly origin: string,
  ) {}

  private challenges = new Map<string, ChallengeEntry>();

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.challenges) {
      if (now - entry.createdAt > CHALLENGE_TTL_MS) this.challenges.delete(k);
    }
  }

  private storeChallenge(logicalKey: string, challengeB64: string): void {
    this.cleanupExpired();
    if (this.challenges.size >= CHALLENGE_MAX) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, entry] of this.challenges) {
        if (entry.createdAt < oldestTs) {
          oldestTs = entry.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) this.challenges.delete(oldestKey);
    }
    this.challenges.set(challengeB64, {
      challenge: challengeB64,
      createdAt: Date.now(),
      logicalKey,
    });
  }

  private popChallengeByKey(logicalKey: string): string | null {
    this.cleanupExpired();
    for (const [b64key, entry] of this.challenges) {
      if (entry.logicalKey === logicalKey) {
        this.challenges.delete(b64key);
        return entry.challenge;
      }
    }
    return null;
  }

  private popChallengeByValue(challengeB64: string): string | null {
    this.cleanupExpired();
    const entry = this.challenges.get(challengeB64);
    if (entry) {
      this.challenges.delete(challengeB64);
      return entry.challenge;
    }
    return null;
  }

  // ============ 注册流程 ============

  async generateRegistrationOptions(
    username: string,
    userId: number,
    existingPasskeys: PasskeyRow[],
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const excludeCredentials = existingPasskeys.map((pk) => ({
      id: pk.credential_id,
      transports: parseTransports(pk.transports),
    }));

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userName: username,
      userDisplayName: username,
      userID: Buffer.from(String(userId), 'utf-8'),
      excludeCredentials: excludeCredentials.length ? excludeCredentials : undefined,
      authenticatorSelection: {
        residentKey: 'required', // Required for usernameless login
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });

    this.storeChallenge(`reg_${username}`, options.challenge);
    logger.debug(`Generated registration challenge for ${username}`);
    return options;
  }

  async verifyRegistration(
    username: string,
    credential: RegistrationResponseJSON,
    deviceName: string,
  ): Promise<VerifiedPasskey> {
    const expectedChallenge = this.popChallengeByKey(`reg_${username}`);
    if (!expectedChallenge) {
      throw new ValueError('Challenge not found or expired');
    }
    try {
      const verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge,
        expectedRPID: this.rpId,
        expectedOrigin: this.origin,
      });
      const info = verification.registrationInfo;
      if (!verification.verified || !info) {
        throw new ValueError('Registration not verified');
      }
      logger.log(`Successfully verified registration for ${username}, device: ${deviceName}`);
      return {
        credentialId: info.credential.id,
        // Python stores base64 (not base64url) of the raw public key bytes
        publicKey: Buffer.from(info.credential.publicKey).toString('base64'),
        signCount: info.credential.counter,
        aaguid: info.aaguid || null,
        backupEligible: info.credentialDeviceType === 'multiDevice',
        backupState: info.credentialBackedUp,
      };
    } catch (e) {
      if (e instanceof ValueError) throw e;
      logger.error(`Registration verification failed: ${e}`);
      throw new ValueError(`Invalid registration response: ${String(e)}`);
    }
  }

  // ============ 认证流程 ============

  async generateAuthenticationOptions(
    username: string,
    passkeys: PasskeyRow[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const allowCredentials = passkeys.map((pk) => ({
      id: pk.credential_id,
      transports: parseTransports(pk.transports),
    }));
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: allowCredentials.length ? allowCredentials : undefined,
      userVerification: 'preferred',
    });
    this.storeChallenge(`auth_${username}`, options.challenge);
    logger.debug(`Generated authentication challenge for ${username}`);
    return options;
  }

  async generateDiscoverableAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: undefined, // Empty = discoverable credentials mode
      userVerification: 'preferred',
    });
    this.storeChallenge(
      `auth_discoverable_${options.challenge.slice(0, 16)}`,
      options.challenge,
    );
    logger.debug('Generated discoverable authentication challenge');
    return options;
  }

  async verifyAuthentication(
    username: string,
    credential: AuthenticationResponseJSON,
    passkey: PasskeyRow,
  ): Promise<number> {
    const expectedChallenge = this.popChallengeByKey(`auth_${username}`);
    if (!expectedChallenge) {
      throw new ValueError('Challenge not found or expired');
    }
    return this.doVerifyAuthentication(credential, passkey, expectedChallenge, username);
  }

  async verifyDiscoverableAuthentication(
    credential: AuthenticationResponseJSON,
    passkey: PasskeyRow,
  ): Promise<number> {
    // Pop the challenge the authenticator actually signed over (from
    // clientDataJSON), not just the first stored discoverable challenge.
    let clientChallenge: string;
    try {
      const clientData = JSON.parse(
        Buffer.from(credential.response.clientDataJSON, 'base64url').toString('utf-8'),
      ) as { challenge?: string };
      if (!clientChallengeValid(clientData.challenge)) throw new Error('no challenge');
      clientChallenge = clientData.challenge!;
    } catch (e) {
      logger.warn(`Failed to parse discoverable authentication response: ${e}`);
      throw new ValueError('Invalid authentication response');
    }
    const expectedChallenge = this.popChallengeByValue(clientChallenge);
    if (!expectedChallenge) {
      throw new ValueError('Challenge not found or expired');
    }
    try {
      return await this.doVerifyAuthentication(credential, passkey, expectedChallenge, null);
    } catch (e) {
      if (e instanceof ValueError) throw e;
      logger.error(`Discoverable authentication verification failed: ${e}`);
      throw new ValueError(`Invalid authentication response: ${String(e)}`);
    }
  }

  private async doVerifyAuthentication(
    credential: AuthenticationResponseJSON,
    passkey: PasskeyRow,
    expectedChallenge: string,
    username: string | null,
  ): Promise<number> {
    try {
      const verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge,
        expectedRPID: this.rpId,
        expectedOrigin: this.origin,
        credential: {
          id: passkey.credential_id,
          publicKey: Buffer.from(passkey.public_key, 'base64'),
          counter: passkey.sign_count ?? 0,
          transports: parseTransports(passkey.transports),
        },
      });
      if (!verification.verified) throw new Error('not verified');
      logger.log(
        username
          ? `Successfully verified authentication for ${username}`
          : 'Successfully verified discoverable authentication',
      );
      return verification.authenticationInfo.newCounter;
    } catch (e) {
      logger.error(`Authentication verification failed: ${e}`);
      throw new ValueError(`Invalid authentication response: ${String(e)}`);
    }
  }
}

function clientChallengeValid(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && challenge.length > 0;
}

/** 解析存储的 transports JSON */
function parseTransports(transportsJson: string | null): AuthenticatorTransport[] {
  if (!transportsJson) return [];
  try {
    const parsed = JSON.parse(transportsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is AuthenticatorTransport => typeof t === 'string');
  } catch {
    return [];
  }
}

// 全局 WebAuthn 服务实例存储：keyed by "rp_id:origin"，LRU 上限 8
const WEBAUTHN_SERVICES_MAX = 8;
const webauthnServices = new Map<string, WebAuthnService>();

export function getWebauthnService(
  rpId: string,
  rpName: string,
  origin: string,
): WebAuthnService {
  const key = `${rpId}:${origin}`;
  const existing = webauthnServices.get(key);
  if (existing) {
    // LRU touch
    webauthnServices.delete(key);
    webauthnServices.set(key, existing);
    return existing;
  }
  if (webauthnServices.size >= WEBAUTHN_SERVICES_MAX) {
    const oldest = webauthnServices.keys().next().value;
    if (oldest !== undefined) webauthnServices.delete(oldest);
  }
  const service = new WebAuthnService(rpId, rpName, origin);
  webauthnServices.set(key, service);
  return service;
}
