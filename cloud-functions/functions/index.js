/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Import the Firebase SDK for Google Cloud Functions.
const functions = require('firebase-functions');
// Import and initialize the Firebase Admin SDK.
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const gcs = require('@google-cloud/storage')();
const vision = require('@google-cloud/vision')();
const exec = require('child-process-promise').exec;

// TODO(DEVELOPER): Import the Cloud Functions for Firebase and the Firebase Admin modules here.

// Adds a message that welcomes new users into the chat.
exports.addWelcomeMessages = functions.auth.user().onCreate(event => {
  const user = event.data;
  console.log('A new user signed in for the first time.');
  const fullName = user.displayName || 'Anonymous';

  // Saves the new welcome message into the database
  // which then displays it in the FriendlyChat clients.
  return admin.database().ref('messages').push({
    name: 'Firebase Bot',
    photoUrl: '/images/firebase-logo.png', // Firebase logo
    text: `${fullName} signed in for the first time! Welcome!`
  });
});

// Blurs uploaded images that are flagged as Adult or Violence.
// Also labels things for what we thought they were.
exports.doMlTasksForImages = functions.storage.object().onChange(event => {
  const object = event.data;
  // Exit if this is a deletion or a deploy event.
  if (object.resourceState === 'not_exists') {
    return console.log('This is a deletion event.');
  } else if (!object.name) {
    return console.log('This is a deploy event.');
  }

  // console.log(`CREATED: ${object.timeCreated}`);
  // console.log(`UPDATED: ${object.updated}`);

  if(! (object.timeCreated === object.updated) )
  {
    return console.log("Already processed this image.");
  }

  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(object.name);

  // var labels = [ "idk" ];

  // console.log('Labeling image:');
  // // PK: let's try and label them, too. 
  // vision.detectLabels(file)
  //   .then((results) => {
  //     labels = results[0];
  //     console.warn("LABELS: "+labels);
  //   })
  //   .catch((err) => {
  //     console.error('ERROR:', err);
  //   });


  console.log('Detecting Similar/Entities:');
  vision.detectSimilar(file)
    .then((results) => {
      const webDetection = results[1].responses[0].webDetection;

      if (webDetection.webEntities.length) {
        console.log(`Web entities found: ${webDetection.webEntities.length}`);
        webDetection.webEntities.forEach((webEntity) => {
          console.log(` ... ${webEntity.description} = ${webEntity.score}`);
        });
        var bestEntityDesc = "IDK";
        bestEntity = webDetection.webEntities.reduce(function(a, b){ return a.score > b.score ? a : b });
        bestEntityDesc = bestEntity.description;


        console.warn(`ENTITY: ${bestEntityDesc}`);

        admin.database().ref('messages').push({
          name: 'Firebase Bot',
          photoUrl: '/images/firebase-logo.png', // Firebase logo
          text: `That looks like a ${bestEntityDesc} to me!`
        });

      }
    })
  .catch((err) => {
    console.error('ERROR:', err);
  });



  console.log('Safety checking image:');

  // Check the image content using the Cloud Vision API.
  return vision.detectSafeSearch(file).then(safeSearchResult => {
    if (safeSearchResult[0].adult || safeSearchResult[0].violence) {
      console.log('BAD!', object.name);
      admin.database().ref('messages').push({
        name: 'Firebase Bot',
        photoUrl: '/images/firebase-logo.png', // Firebase logo
        text: `I don't like that image.  BAD!`
      });

      return blurImage(object.name, bucket);
    } else {
      console.log('GOOD!', object.name);
    }
  });



});


// Blurs the given image located in the given bucket using ImageMagick.
function blurImage(filePath, bucket, metadata) {
  const fileName = filePath.split('/').pop();
  const tempLocalFile = `/tmp/${fileName}`;
  const messageId = filePath.split('/')[1];

  // Download file from bucket.
  return bucket.file(filePath).download({destination: tempLocalFile})
    .then(() => {
      console.log('Image has been downloaded to', tempLocalFile);
      // Blur the image using ImageMagick.
      return exec(`convert ${tempLocalFile} -channel RGBA -blur 0x24 ${tempLocalFile}`);
    }).then(() => {
      console.log('Image has been blurred');
      // Uploading the Blurred image back into the bucket.
      return bucket.upload(tempLocalFile, {destination: filePath});
    }).then(() => {
      console.log('Blurred image has been uploaded to', filePath);
      // Indicate that the message has been moderated.
      return admin.database().ref(`/messages/${messageId}`).update({moderated: true});
    }).then(() => {
      console.log('Marked the image as moderated in the database.');
    });
}

// Sends a notifications to all users when a new message is posted.
exports.sendNotifications = functions.database.ref('/messages/{messageId}').onWrite(event => {
  const snapshot = event.data;
  // Only send a notification when a message has been created.
  if (snapshot.previous.val()) {
    return;
  }

  // Notification details.
  const text = snapshot.val().text;
  const payload = {
    notification: {
      title: `${snapshot.val().name} posted ${text ? 'a message' : 'an image'}`,
      body: text ? (text.length <= 100 ? text : text.substring(0, 97) + '...') : '',
      icon: snapshot.val().photoUrl || '/images/profile_placeholder.png',
      click_action: `https://${functions.config().firebase.authDomain}`
    }
  };

  // Get the list of device tokens.
  return admin.database().ref('fcmTokens').once('value').then(allTokens => {
    if (allTokens.val()) {
      // Listing all tokens.
      const tokens = Object.keys(allTokens.val());

      // Send notifications to all tokens.
      return admin.messaging().sendToDevice(tokens, payload).then(response => {
        // For each message check if there was an error.
        const tokensToRemove = [];
        response.results.forEach((result, index) => {
          const error = result.error;
          if (error) {
            console.error('Failure sending notification to', tokens[index], error);
            // Cleanup the tokens who are not registered anymore.
            if (error.code === 'messaging/invalid-registration-token' ||
                error.code === 'messaging/registration-token-not-registered') {
              tokensToRemove.push(allTokens.ref.child(tokens[index]).remove());
            }
          }
        });
        return Promise.all(tokensToRemove);
      });
    }
  });
});

