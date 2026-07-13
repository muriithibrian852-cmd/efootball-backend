/* =========================================================================
   SERVER.JS — MatchdayVote Backend
   -------------------------------------------------------------------------
   What this does:
   1. Stores vote counts centrally in a JSON file (votes.json) so every
      visitor sees the SAME numbers — not just their own browser.
   2. Verifies every payment with Paystack's secret key BEFORE crediting a
      vote, so nobody can fake a "successful payment" from the browser.
   3. Prevents the same payment reference from being credited twice.
   4. Serves a simple /api/candidates endpoint the frontend polls to stay
      in sync with everyone else's votes.

   Requires Node.js 18+ (for built-in fetch). Check with: node -v
   ========================================================================= */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());              // allows your frontend (on a different domain) to call this API
app.use(express.json());

const PORT = process.env.PORT || 5000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // ⚠️ set this in your .env — never in frontend code
const PRICE_PER_VOTE = Number(process.env.PRICE_PER_VOTE || 50); // must match data.js on the frontend
const DB_FILE = path.join(__dirname, "votes.json");

/* -------------------------------------------------------------------------
   Simple JSON-file "database". Good enough for a contest like this.
   Structure: { candidates: { a1: 0, a2: 0, ... }, usedReferences: [...], ballots: [...] }
   ---------------------------------------------------------------------- */
const DEFAULT_CANDIDATE_IDS = ["a1", "a2", "a3", "a4", "a5", "a6"];

function loadDB(){
  if(!fs.existsSync(DB_FILE)){
    const initial = {
      candidates: Object.fromEntries(DEFAULT_CANDIDATE_IDS.map(id => [id, 0])),
      usedReferences: [],
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
   GET /api/candidates — the frontend polls this to get real, shared vote
   counts for every candidate.
   ---------------------------------------------------------------------- */
app.get("/api/candidates", (req, res) => {
  const db = loadDB();
  res.json({ candidates: db.candidates });
});

/* -------------------------------------------------------------------------
   POST /api/vote/verify — called after the Paystack popup reports success.
   This is the important part: we do NOT trust the frontend. We ask
   Paystack directly whether this reference really was paid, then credit
   the vote only if it checks out.
   ---------------------------------------------------------------------- */
app.post("/api/vote/verify", async (req, res) => {
  try{
    const { reference, candidateId, votes, voterName, relationship, reasons, customReason, rating } = req.body;

    if(!reference || !candidateId || !votes){
      return res.status(400).json({ ok: false, error: "Missing reference, candidateId, or votes." });
    }

    const db = loadDB();

    // 1. Reject if this payment reference was already credited (stops double-voting via refresh/retry)
    if(db.usedReferences.includes(reference)){
      return res.status(409).json({ ok: false, error: "This payment has already been credited." });
    }

    // 2. Ask Paystack directly whether this transaction really succeeded
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();

    if(!verifyData.status || verifyData.data?.status !== "success"){
      return res.status(402).json({ ok: false, error: "Payment could not be verified as successful." });
    }

    // 3. Make sure the amount actually paid matches what the vote count should cost
    //    (stops someone paying for 1 vote but claiming 100 in the request body)
    const expectedAmount = Number(votes) * PRICE_PER_VOTE * 100; // Paystack amounts are in subunits (kobo/cents)
    if(verifyData.data.amount < expectedAmount){
      return res.status(402).json({ ok: false, error: "Amount paid does not match votes requested." });
    }

    // 4. All good — credit the vote
    if(!(candidateId in db.candidates)) db.candidates[candidateId] = 0;
    db.candidates[candidateId] += Number(votes);
    db.usedReferences.push(reference);
    db.ballots.push({
      reference, candidateId, votes: Number(votes), voterName, relationship,
      reasons, customReason, rating, amount: verifyData.data.amount / 100,
      timestamp: new Date().toISOString()
    });
    saveDB(db);

    res.json({ ok: true, candidates: db.candidates });

  } catch(err){
    console.error(err);
    res.status(500).json({ ok: false, error: "Server error while verifying payment." });
  }
});

app.get("/", (req, res) => res.send("MatchdayVote backend is running."));

app.listen(PORT, () => console.log(`MatchdayVote backend listening on port ${PORT}`));
