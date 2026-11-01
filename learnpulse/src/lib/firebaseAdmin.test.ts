import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import admin from 'firebase-admin';
import { describe, it } from 'node:test';

import {
  FirebaseAdminConfigurationError,
  initializeFirebaseAdmin,
  resolveFirebaseAdminCredential,
  verifyFirebaseIdToken,
} from './firebaseAdmin';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const serviceAccountJson = JSON.stringify({
  type: 'service_account',
  project_id: 'learnpulse-test-project',
  private_key: privateKey,
  client_email: 'test-account@learnpulse-test-project.iam.gserviceaccount.com',
});

describe('Firebase Admin configuration', () => {
  it('reports missing credentials safely when Application Default Credentials are unavailable', () => {
    assert.throws(
      () => resolveFirebaseAdminCredential({}, {
        applicationDefault: () => {
          throw new Error('private credential data must not be surfaced');
        },
        cert: admin.credential.cert,
      }),
      (error: unknown) => error instanceof FirebaseAdminConfigurationError
        && error.message.includes('Configure FIREBASE_SERVICE_ACCOUNT_JSON')
        && !error.message.includes('private credential data'),
    );
  });

  it('rejects malformed or incomplete service-account JSON without exposing its contents', () => {
    for (const value of ['not-json', JSON.stringify({ project_id: 'missing-fields' })]) {
      assert.throws(
        () => resolveFirebaseAdminCredential({ serviceAccountJson: value }),
        (error: unknown) => error instanceof FirebaseAdminConfigurationError
          && !error.message.includes(value),
      );
    }
  });

  it('rejects a service account with an invalid private key without exposing key details', () => {
    const invalidServiceAccount = JSON.stringify({
      type: 'service_account',
      project_id: 'learnpulse-test-project',
      client_email: 'test-account@learnpulse-test-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\ninvalid-key\n-----END PRIVATE KEY-----',
    });
    assert.throws(
      () => resolveFirebaseAdminCredential({ serviceAccountJson: invalidServiceAccount }),
      (error: unknown) => error instanceof FirebaseAdminConfigurationError
        && error.message.includes('invalid service-account credentials')
        && !error.message.includes('invalid-key'),
    );
  });

  it('rejects conflicting credential sources and project IDs', () => {
    assert.throws(
      () => resolveFirebaseAdminCredential({
        serviceAccountJson,
        credentialsPath: 'firebase-service-account.json',
      }),
      /Configure either FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS/,
    );
    assert.throws(
      () => initializeFirebaseAdmin({
        serviceAccountJson,
        projectId: 'different-project',
      }),
      /does not match the service-account project/,
    );
  });

  it('initializes the default Admin app once with the service-account project', async () => {
    assert.equal(admin.apps.some((app) => app?.name === '[DEFAULT]'), false);
    try {
      const config = { serviceAccountJson };
      const firstApp = initializeFirebaseAdmin(config);
      const secondApp = initializeFirebaseAdmin(config);
      assert.equal(firstApp, secondApp);
      assert.equal(admin.apps.filter((app) => app?.name === '[DEFAULT]').length, 1);
      assert.equal(firstApp.options.projectId, 'learnpulse-test-project');
      assert.equal(firstApp.auth() !== undefined, true);
      assert.equal(firstApp.firestore() !== undefined, true);
    } finally {
      const app = admin.apps.find((candidate) => candidate?.name === '[DEFAULT]');
      if (app) await app.delete();
    }
  });
});

describe('Firebase ID-token verification', () => {
  it('verifies tokens with revocation checking enabled', async () => {
    let receivedToken = '';
    let checkedRevocation: boolean | undefined;
    const auth = {
      verifyIdToken: async (idToken: string, checkRevoked?: boolean) => {
        receivedToken = idToken;
        checkedRevocation = checkRevoked;
        return { uid: 'student-uid' };
      },
    };

    assert.deepEqual(await verifyFirebaseIdToken(auth, 'signed-id-token'), { uid: 'student-uid' });
    assert.equal(receivedToken, 'signed-id-token');
    assert.equal(checkedRevocation, true);
  });

  it('rejects invalid tokens instead of returning a success-shaped fallback', async () => {
    const auth = {
      verifyIdToken: async () => {
        throw new Error('invalid token');
      },
    };
    await assert.rejects(verifyFirebaseIdToken(auth, 'invalid-token'), /invalid token/);
  });
});
