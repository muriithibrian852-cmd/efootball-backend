/* =========================================================================
   SERVER.JS — MatchdayVote Backend (PayHero STK Push, JSON-file storage)
   -------------------------------------------------------------------------
   Uses PayHero (payherokenya.com) instead of direct Safaricom Daraja or
   Paystack. PayHero handles all the M-Pesa-specific complexity for you —
   you just call their API with a Basic Auth token.

   Flow:
   1. Frontend sends phone number + vote details to /api/payhero/stkpush
   2. This file asks PayHero to trigger an STK push to that phone
   3. PayHero calls US BACK at /api/payhero/callback once the customer
      enters their PIN (needs a public HTTPS URL — Render gives you that)
   4. Frontend polls /api/payhero/status/:id every few seconds until it
      sees "completed" or "failed"
   ========================================================================= */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const PRICE_PER_VOTE = Number(process.env.PRICE_PER_VOTE || 20);
const DB_FILE = path.join(__dirname, "votes.json");

// ⚠️ The full "Basic xxxxxxx==" string from PayHero's dashboard — see
// Authorization docs: "How To Get Basic Auth Token From UI"
const PAYHERO_AUTH_TOKEN = process.env.PAYHERO_AUTH_TOKEN;
const PAYHERO_CHANNEL_ID = process.env.PAYHERO_CHANNEL_ID;
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL; // e.g. https://your-backend.onrender.com/api/payhero/callback

/* -------------------------------------------------------------------------
   Same JSON-file "database" style as your existing backend.
   ---------------------------------------------------------------------- */
const DEFAULT_CANDIDATE_IDS = ["a1", "a2", "a3", "a4", "a5", "a6"];

function loadDB(){
  if(!fs.existsSync(DB_FILE)){
    const initial = {
      candidates: Object.fromEntries(DEFAULT_CANDIDATE_IDS.map(id => [id, 0])),
      transactions: {},   // keyed by CheckoutRequestID
      ballots: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}
function saveDB(db){
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* -------------------------------------------------------------------------
   GET /api/candidates
   ---------------------------------------------------------------------- */
app.get("/api/candidates", (req, res) => {
  const db = loadDB();
  res.json({ candidates: db.candidates });
});

/* -------------------------------------------------------------------------
   POST /api/payhero/stkpush — triggers the PIN prompt on the voter's phone
   ---------------------------------------------------------------------- */
app.post("/api/payhero/stkpush", async (req, res) => {
  try{
    const { phone, candidateId, votes, voterName, relationship, reasons, customReason, rating } = req.body;

    if(!phone || !candidateId || !votes){
      return res.status(400).json({ ok: false, error: "Missing phone, candidateId, or votes." });
    }

    let cleanPhone = phone.replace(/\D/g, "");
    if(cleanPhone.startsWith("254")) cleanPhone = "0" + cleanPhone.slice(3); // PayHero examples use 07XXXXXXXX format
    if(!cleanPhone.startsWith("0")) cleanPhone = "0" + cleanPhone;

    const amount = Number(votes) * PRICE_PER_VOTE;
    const externalReference = "vote_" + candidateId + "_" + Date.now();

    const stkRes = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: {
        Authorization: PAYHERO_AUTH_TOKEN,   // already the full "Basic xxxx" string
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount,
        phone_number: cleanPhone,
        channel_id: Number(PAYHERO_CHANNEL_ID),
        provider: "m-pesa",
        external_reference: externalReference,
        customer_name: voterName,
        callback_url: PAYHERO_CALLBACK_URL
      })
    });
    const stkData = await stkRes.json();

    if(!stkData.CheckoutRequestID){
      console.error("PayHero STK push failed:", stkData);
      return res.status(502).json({ ok: false, error: stkData.error_message || "Could not start the M-Pesa prompt." });
    }

    const db = loadDB();
    db.transactions[stkData.CheckoutRequestID] = {
      candidateId, votes: Number(votes), voterName, relationship,
      reasons, customReason, rating, amount, phone: cleanPhone,
      externalReference, status: "pending"
    };
    saveDB(db);

    res.json({ ok: true, checkoutRequestId: stkData.CheckoutRequestID });

  } catch(err){
    console.error(err);
    res.status(500).json({ ok: false, error: "Server error while starting M-Pesa payment." });
  }
});

/* -------------------------------------------------------------------------
   POST /api/payhero/callback — PayHero calls THIS automatically once the
   customer enters their PIN (or cancels/times out).
   PayHero sends: { status: true/false, response: { CheckoutRequestID,
   ResultCode, Status: "Success"/"Failed", MpesaReceiptNumber, ... } }
   ---------------------------------------------------------------------- */
app.post("/api/payhero/callback", (req, res) => {
  try{
    const payload = req.body?.response;
    if(!payload) return res.sendStatus(400);

    const checkoutRequestId = payload.CheckoutRequestID;
    const success = payload.ResultCode === 0 && payload.Status === "Success";

    const db = loadDB();
    const txn = db.transactions[checkoutRequestId];

    if(!txn){
      console.warn("Callback for unknown transaction:", checkoutRequestId);
      return res.sendStatus(200);
    }

    if(success){
      if(!(txn.candidateId in db.candidates)) db.candidates[txn.candidateId] = 0;
      db.candidates[txn.candidateId] += txn.votes;
      db.ballots.push({
        ...txn, checkoutRequestId,
        mpesaReceipt: payload.MpesaReceiptNumber,
        timestamp: new Date().toISOString()
      });
      txn.status = "completed";
    } else {
      txn.status = "failed";
    }
    saveDB(db);

    res.sendStatus(200);
  } catch(err){
    console.error(err);
    res.sendStatus(500);
  }
});

/* -------------------------------------------------------------------------
   GET /api/payhero/status/:checkoutRequestId — the frontend polls this
   ---------------------------------------------------------------------- */
app.get("/api/payhero/status/:id", (req, res) => {
  const db = loadDB();
  const txn = db.transactions[req.params.id];
  if(!txn) return res.status(404).json({ status: "unknown" });
  res.json({ status: txn.status });
});

app.get("/", (req, res) => res.send("MatchdayVote backend (PayHero) is running."));

app.listen(PORT, () => console.log(`MatchdayVote backend listening on port ${PORT}`));
