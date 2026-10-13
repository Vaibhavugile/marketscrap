
"use strict";

const admin = require("firebase-admin");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

async function saveApprovedResult({
  marketId,
  marketName,
  stage,
  result,
  sources,
  checkedAt,
}) {
  if (!marketId || !["open", "close"].includes(stage) || !result) {
    throw new Error("Invalid approved result data.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  const resultRef = db
    .collection("marketResults")
    .doc(marketId);

  await resultRef.set(
    {
      marketId,
      marketName,
      [`${stage}Result`]: result,
      [`${stage}ApprovedAt`]: now,
      [`${stage}Sources`]: sources || [],
      [`${stage}CheckedAt`]: checkedAt || null,
      updatedAt: now,
    },
    { merge: true }
  );
}

async function getStageState(marketId, stage, dateKey) {
  const ref = db
    .collection("marketScraperState")
    .doc(`${dateKey}_${marketId}_${stage}`);

  const snapshot = await ref.get();

  return {
    ref,
    data: snapshot.exists ? snapshot.data() : null,
  };
}

async function saveStageState(ref, data) {
  await ref.set(
    {
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

module.exports = {
  db,
  saveApprovedResult,
  getStageState,
  saveStageState,
};
