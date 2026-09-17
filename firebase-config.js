// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAsuOgiPKYiZc_vP1E8JEaKufr3Bod51a8",
  authDomain: "chem-karut.firebaseapp.com",
  databaseURL: "https://chem-karut-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "chem-karut",
  storageBucket: "chem-karut.firebasestorage.app",
  messagingSenderId: "283699409494",
  appId: "1:283699409494:web:41a17f4c8551d0224c81f7",
  measurementId: "G-8N22NYHZQZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);