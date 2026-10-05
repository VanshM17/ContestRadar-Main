/* ContestRadar Firebase bridge (ES module — deferred, runs before DOMContentLoaded).
   Exposes window.FB = { ready, auth, db, ... } or { ready: false } when offline/blocked.
   The classic script.js talks to Firebase ONLY through window.FB / the Cloud adapter. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, Timestamp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const firebaseConfig = {
    apiKey: "AIzaSyD8FdBRIoXeuonL2Yr0NjZjro81t5-tQC8",
    authDomain: "contest--radar.firebaseapp.com",
    projectId: "contest--radar",
    storageBucket: "contest--radar.firebasestorage.app",
    messagingSenderId: "509789061152",
    appId: "1:509789061152:web:285a17af14ff2732757c45",
    measurementId: "G-8Z40EW32J8"
};

let FB = { ready: false };
try {
    const app = initializeApp(firebaseConfig);
    FB = {
        ready: true,
        auth: getAuth(app),
        db: getFirestore(app),
        GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
        doc, getDoc, setDoc, Timestamp
    };
} catch (e) {
    console.warn('Firebase init failed — running local-only:', e);
}
window.FB = FB;
document.dispatchEvent(new Event('fb-ready'));
