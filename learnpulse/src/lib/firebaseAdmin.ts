import admin from 'firebase-admin';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type FirebaseAdminConfig = {
  serviceAccountJson?: string;
  credentialsPath?: string;
  projectId?: string;
  storageBucket?: string;
};

type FirebaseAdminCredentialProvider = Pick<typeof admin.credential, 'applicationDefault' | 'cert'>;

export class FirebaseAdminConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseAdminConfigurationError';
  }
}

function parseServiceAccountJson(value: string): admin.ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new FirebaseAdminConfigurationError(
      'FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FirebaseAdminConfigurationError(
      'FIREBASE_SERVICE_ACCOUNT_JSON must contain a service-account object.',
    );
  }

  const record = parsed as Record<string, unknown>;
  if (
    record.type !== 'service_account'
    || typeof record.project_id !== 'string'
    || !record.project_id.trim()
    || typeof record.client_email !== 'string'
    || !record.client_email.trim()
    || typeof record.private_key !== 'string'
    || !record.private_key.includes('-----BEGIN PRIVATE KEY-----')
    || !record.private_key.includes('-----END PRIVATE KEY-----')
  ) {
    throw new FirebaseAdminConfigurationError(
      'FIREBASE_SERVICE_ACCOUNT_JSON is missing valid service-account fields.',
    );
  }

  return {
    projectId: record.project_id,
    clientEmail: record.client_email,
    privateKey: record.private_key,
  };
}

export function resolveFirebaseAdminCredential(
  config: FirebaseAdminConfig,
  credentialProvider: FirebaseAdminCredentialProvider = admin.credential,
): admin.credential.Credential {
  const serviceAccountJson = config.serviceAccountJson?.trim();
  const credentialsPath = config.credentialsPath?.trim();

  if (serviceAccountJson && credentialsPath) {
    throw new FirebaseAdminConfigurationError(
      'Configure either FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS, not both.',
    );
  }

  if (serviceAccountJson) {
    const serviceAccount = parseServiceAccountJson(serviceAccountJson);
    if (config.projectId && config.projectId !== serviceAccount.projectId) {
      throw new FirebaseAdminConfigurationError(
        'The configured Firebase project does not match the service-account project.',
      );
    }
    try {
      return credentialProvider.cert(serviceAccount);
    } catch {
      throw new FirebaseAdminConfigurationError(
        'FIREBASE_SERVICE_ACCOUNT_JSON contains invalid service-account credentials.',
      );
    }
  }

  if (credentialsPath && !existsSync(path.resolve(credentialsPath))) {
    throw new FirebaseAdminConfigurationError(
      'The configured GOOGLE_APPLICATION_CREDENTIALS file does not exist.',
    );
  }

  try {
    return credentialProvider.applicationDefault();
  } catch {
    throw new FirebaseAdminConfigurationError(
      'Firebase Admin credentials are unavailable. Configure FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or Application Default Credentials.',
    );
  }
}

export function initializeFirebaseAdmin(
  config: FirebaseAdminConfig,
  sdk: typeof admin = admin,
): admin.app.App {
  const projectId = config.projectId?.trim();
  const serviceAccountJson = config.serviceAccountJson?.trim();
  let serviceAccountProjectId: string | undefined;
  if (serviceAccountJson) {
    serviceAccountProjectId = parseServiceAccountJson(serviceAccountJson).projectId;
    if (projectId && projectId !== serviceAccountProjectId) {
      throw new FirebaseAdminConfigurationError(
        'The configured Firebase project does not match the service-account project.',
      );
    }
  }

  const existingApp = sdk.apps.find((candidate) => candidate?.name === '[DEFAULT]') ?? null;
  if (existingApp) {
    if (projectId && existingApp.options.projectId !== projectId) {
      throw new FirebaseAdminConfigurationError(
        'The initialized Firebase Admin project does not match the configured Firebase project.',
      );
    }
    return existingApp;
  }

  const credential = resolveFirebaseAdminCredential(config, sdk.credential);
  return sdk.initializeApp({
    credential,
    ...((projectId || serviceAccountProjectId)
      ? { projectId: projectId || serviceAccountProjectId }
      : {}),
    ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
  });
}

export function verifyFirebaseIdToken<T>(
  auth: { verifyIdToken: (idToken: string, checkRevoked?: boolean) => Promise<T> },
  idToken: string,
): Promise<T> {
  return auth.verifyIdToken(idToken, true);
}
