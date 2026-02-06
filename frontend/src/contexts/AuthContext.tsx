import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { getConfig } from '../config';

interface User {
  email: string;
  userId: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  confirmRegistration: (email: string, code: string) => Promise<void>;
  logout: () => void;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

let userPool: CognitoUserPool | null = null;

async function getUserPool(): Promise<CognitoUserPool> {
  if (userPool) return userPool;
  
  const config = await getConfig();
  userPool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  return userPool;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    async function checkSession() {
      try {
        const pool = await getUserPool();
        const cognitoUser = pool.getCurrentUser();
        
        if (cognitoUser) {
          cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
            if (err || !session?.isValid()) {
              setUser(null);
            } else {
              const payload = session.getIdToken().decodePayload();
              setUser({
                email: payload.email,
                userId: payload.sub,
              });
            }
            setLoading(false);
          });
        } else {
          setLoading(false);
        }
      } catch {
        setLoading(false);
      }
    }
    
    checkSession();
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const pool = await getUserPool();
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: pool,
    });

    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    return new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          const payload = session.getIdToken().decodePayload();
          setUser({
            email: payload.email,
            userId: payload.sub,
          });
          resolve();
        },
        onFailure: (err) => {
          reject(err);
        },
        newPasswordRequired: () => {
          reject(new Error('New password required'));
        },
      });
    });
  }, []);

  const register = useCallback(async (email: string, password: string, name: string): Promise<void> => {
    const pool = await getUserPool();
    
    const attributeList = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
      new CognitoUserAttribute({ Name: 'name', Value: name }),
    ];

    return new Promise((resolve, reject) => {
      pool.signUp(email, password, attributeList, [], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }, []);

  const confirmRegistration = useCallback(async (email: string, code: string): Promise<void> => {
    const pool = await getUserPool();
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: pool,
    });

    return new Promise((resolve, reject) => {
      cognitoUser.confirmRegistration(code, true, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }, []);

  const logout = useCallback(async () => {
    const pool = await getUserPool();
    const cognitoUser = pool.getCurrentUser();
    if (cognitoUser) {
      cognitoUser.signOut();
    }
    setUser(null);
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    const pool = await getUserPool();
    const cognitoUser = pool.getCurrentUser();
    
    if (!cognitoUser) return null;

    return new Promise((resolve) => {
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session?.isValid()) {
          resolve(null);
        } else {
          resolve(session.getIdToken().getJwtToken());
        }
      });
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, confirmRegistration, logout, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
