// backend/server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Configuration, OpenAIApi } = require('openai');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Silence detection parameters
// const SILENCE_THRESHOLD = 0.01;
const SILENCE_THRESHOLD = 0.01;
const SILENCE_DURATION = 2000; // 2 seconds

io.on('connection', (socket) => {
  console.log('A user connected');
  let audioBuffer = [];
  let silenceStart = null;
  let isProcessing = false;

  socket.on('audio_data', (data) => {
    if (isProcessing) return;

    audioBuffer = audioBuffer.concat(data);

    // Check for silence
    const isSound = data.some(sample => Math.abs(sample) > SILENCE_THRESHOLD);
    
    if (!isSound) {
      if (!silenceStart) {
        silenceStart = Date.now();
      } else if (Date.now() - silenceStart >= SILENCE_DURATION) {
        processAudio();
      }
    } else {
      silenceStart = null;
    }
  });

  socket.on('stop_recording', () => {
    processAudio();
  });

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0) return;
    isProcessing = true;

    try {
      const fileName = `audio_${Date.now()}.wav`;
      const filePath = path.join(__dirname, 'temp', fileName);
      
      // Convert buffer to WAV file
      const wavBuffer = createWavBuffer(audioBuffer);
      fs.writeFileSync(filePath, Buffer.from(wavBuffer));

      const transcript = await openai.createTranscription(
        fs.createReadStream(filePath),
        "whisper-1",
        "en"  // Specify English language here
      );

      console.log('Transcription:', transcript.data.text);

      const response = `You said: ${transcript.data.text}`;

      // Use the OpenAI API directly for text-to-speech
      const speechResponse = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: "tts-1",
          input: response,
          voice: "alloy"
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
        }
      );

      const speechFileName = `speech_${Date.now()}.mp3`;
      const speechFilePath = path.join(__dirname, 'temp', speechFileName);
      fs.writeFileSync(speechFilePath, Buffer.from(speechResponse.data));

      socket.emit('receive_audio', {
        audioUrl: `${process.env.BACKEND_URL}/temp/${speechFileName}`,
        transcription: transcript.data.text,
        response: response
      });

      setTimeout(() => {
        fs.unlinkSync(filePath);
        fs.unlinkSync(speechFilePath);
      }, 60000); // 1 minute delay

    } catch (error) {
      console.error('Error processing audio:', error);
      socket.emit('')
    //   socket.emit('error', 'Error processing audio: ' + error.message);
    } finally {
      audioBuffer = [];
      silenceStart = null;
      isProcessing = false;
    }
  }

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

function createWavBuffer(audioData) {
  const sampleRate = 44100;
  const buffer = new ArrayBuffer(44 + audioData.length * 2);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + audioData.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, audioData.length * 2, true);

  // Audio data
  for (let i = 0; i < audioData.length; i++) {
    view.setInt16(44 + i * 2, audioData[i] * 32767, true);
  }

  return buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

app.use('/temp', express.static(path.join(__dirname, 'temp')));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
