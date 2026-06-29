"use client";

import { initializeApp, getApps, getApp, type FirebaseOptions } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Fallbacks keep module init from throwing during static prerender when env
// vars aren't present (e.g. CI). At runtime your real NEXT_PUBLIC_* values apply.
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "missing-api-key",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "example.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "example",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "example.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "0",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "0",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const storage = getStorage(firebaseApp);
// Auth-only provider: standard implicit-grant flow — no extra scopes, no offline.
// access_type:"offline" forces the code-grant flow which Firebase's redirect handler
// cannot process, causing signInWithRedirect to return null and signInWithPopup to hang.
export const googleAuthProvider = new GoogleAuthProvider();

// Gmail-scoped provider: used by the post-login OAuth integration flow to request
// inbox read access and a refresh token. NOT for initial sign-in.
export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("https://www.googleapis.com/auth/gmail.readonly");
googleProvider.setCustomParameters({ access_type: "offline", prompt: "consent" });

export const appleProvider = new OAuthProvider("apple.com");
appleProvider.addScope("email");
appleProvider.addScope("name");
