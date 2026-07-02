import React, { createContext, useContext, useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser as fbDeleteUser,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile as fbUpdateProfile,
  User,
} from "firebase/auth";
import { auth } from "@/src/lib/firebase";
import { api } from "@/src/lib/api";

type AuthContextValue = {
  user: User | null;
  initializing: boolean;
  signUp: (email: string, password: string, displayName?: string) => Promise<User>;
  signIn: (email: string, password: string) => Promise<User>;
  resetPassword: (email: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  deleteAccount: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setInitializing(false);
    });
    return unsub;
  }, []);

  const signUp = async (email: string, password: string, displayName?: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) {
      await fbUpdateProfile(cred.user, { displayName });
    }
    return cred.user;
  };

  const signIn = async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  };

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  };

  const signOutUser = async () => {
    await signOut(auth);
  };

  const deleteAccount = async () => {
    // 1) Wipe server-side data first (uses X-User-Id from the current Firebase token).
    await api.deleteMyAccount();
    // 2) Then delete the Firebase Auth user itself. Firebase may throw
    //    `auth/requires-recent-login` if the ID token is too old; caller should
    //    re-authenticate and retry in that case.
    if (auth.currentUser) {
      await fbDeleteUser(auth.currentUser);
    }
  };

  return (
    <AuthContext.Provider value={{ user, initializing, signUp, signIn, resetPassword, signOutUser, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
