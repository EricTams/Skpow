import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, type Auth, type User } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';

export interface FirebaseClient {
  readonly app: FirebaseApp;
  readonly auth: Auth;
  readonly database: Database;
}

export interface FirebaseRuntimeConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly databaseURL: string;
  readonly projectId: string;
  readonly appId: string;
}

let client: FirebaseClient | null = null;

export function readFirebaseConfig(): FirebaseRuntimeConfig | null {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  return Object.values(config).every(Boolean) ? config : null;
}

export function isFirebaseConfigured(): boolean {
  return readFirebaseConfig() !== null;
}

export function getFirebaseClient(): FirebaseClient | null {
  const config = readFirebaseConfig();
  if (!config) {
    return null;
  }

  if (!client) {
    const app = initializeApp(config);
    client = {
      app,
      auth: getAuth(app),
      database: getDatabase(app),
    };
  }

  return client;
}

export async function signInWithAnonymousAuth(): Promise<User | null> {
  const firebase = getFirebaseClient();
  if (!firebase) {
    return null;
  }

  const credential = await signInAnonymously(firebase.auth);
  return credential.user;
}

export function observeAnonymousUser(onChange: (user: User | null) => void): () => void {
  const firebase = getFirebaseClient();
  if (!firebase) {
    onChange(null);
    return () => undefined;
  }

  return onAuthStateChanged(firebase.auth, onChange);
}
