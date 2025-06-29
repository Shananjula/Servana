/* eslint-disable max-len */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Sends a push notification and saves a record in the user's notification subcollection.
 * @param {string} userId The ID of the user to notify.
 * @param {string} title The title of the notification.
 * @param {string} body The body text of the notification.
 * @param {object} [dataPayload={}] Optional data to send with the notification.
 */
const sendAndSaveNotification = async (userId, title, body, dataPayload = {}) => {
  try {
    // Save notification to the user's subcollection for their notification feed
    await db.collection("users").doc(userId).collection("notifications").add({
      title: title,
      body: body,
      isRead: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...dataPayload,
    });

    // Get the user's FCM tokens to send the push notification
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      console.log(`User ${userId} not found, cannot send notification.`);
      return;
    }
    const fcmTokens = userDoc.data().fcmTokens;

    if (fcmTokens && fcmTokens.length > 0) {
      const payload = {
        notification: {title, body},
        data: dataPayload,
      };
      await admin.messaging().sendToDevice(fcmTokens, payload);
    }
  } catch (error) {
    console.error(`Error sending notification to ${userId}:`, error);
  }
};

// --- Triggers for Task Management and Activity Feed ---
exports.onTaskCreateForActivity = functions.firestore
    .document("tasks/{taskId}")
    .onCreate((snap, context) => {
      const task = snap.data();
      if (!task.posterId) return null;
      return snap.ref.set({
        participantIds: [task.posterId],
      }, {merge: true});
    });

exports.onTaskUpdateForActivity = functions.firestore
    .document("tasks/{taskId}")
    .onUpdate((change, context) => {
      const before = change.before.data();
      const after = change.after.data();

      if (!before.assignedHelperId && after.assignedHelperId) {
        return change.after.ref.update({
          participantIds: admin.firestore.FieldValue.arrayUnion(after.assignedHelperId),
        });
      }
      return null;
    });

// --- NEW: Cloud Function for "Task Radio" ---
exports.onUrgentTaskCreate = functions.firestore
    .document("tasks/{taskId}")
    .onCreate(async (snap, context) => {
      const task = snap.data();
      if (!task.isUrgent || !task.location) return null;

      const liveHelpersSnapshot = await db.collection("users")
          .where("isLive", "==", true)
          .where("isHelper", "==", true)
          .get();

      if (liveHelpersSnapshot.empty) {
        console.log("No live helpers found for urgent task.");
        return null;
      }

      const taskLat = task.location.latitude;
      const taskLon = task.location.longitude;

      const promises = [];
      liveHelpersSnapshot.forEach((doc) => {
        const helper = doc.data();
        if (helper.workLocation) {
          const helperLat = helper.workLocation.latitude;
          const helperLon = helper.workLocation.longitude;

          const R = 6371; // Earth's radius in km
          const dLat = (helperLat - taskLat) * (Math.PI / 180);
          const dLon = (helperLon - taskLon) * (Math.PI / 180);
          const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(taskLat * (Math.PI / 180)) *
                    Math.cos(helperLat * (Math.PI / 180)) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const distance = R * c;

          if (distance <= 10) { // Notify helpers within a 10km radius
            const promise = sendAndSaveNotification(
                doc.id,
                "🚨 Urgent Task Nearby!",
                `"${task.title}" is just ${distance.toFixed(1)}km away.`,
                {type: "task_details", relatedId: snap.id},
            );
            promises.push(promise);
          }
        }
      });

      return Promise.all(promises);
    });

// --- Notification Triggers ---
exports.sendOfferNotification = functions.firestore
    .document("tasks/{taskId}/offers/{offerId}")
    .onCreate(async (snap, context) => {
      const offer = snap.data();
      const taskDoc = await db.collection("tasks").doc(offer.taskId).get();
      const task = taskDoc.data();

      return sendAndSaveNotification(
          task.posterId,
          `New Offer for "${task.title}"`,
          `${offer.helperName} has made an offer of LKR ${offer.amount}.`,
          {type: "task_offer", relatedId: offer.taskId},
      );
    });

exports.onUserCreateSetup = functions.auth.user().onCreate((user) => {
  return db.collection("users").doc(user.uid).set({
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    isHelper: false,
    trustScore: 10, // Starting trust score
  }, {merge: true});
});
