const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const https = require('https');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
dotenv.config();
const app = express();
app.use(bodyParser.json());

const {
  PORT,
  EXOTEL_SID,
  EXOTEL_API_KEY,
  EXOTEL_API_TOKEN,
  EXOPHONE,
  CANDIDATE_NUMBER,
  ULTRAVOX_API_KEY,
  GEMINI_API_KEY,
  MERGE_SERVER_URL,
  JOB_DESC_URL
} = process.env;

let JOIN_URL = null;

// === STEP 1: Scrape
async function scrapeJob() {
  const { data } = await axios.get(JOB_DESC_URL);
  const $ = cheerio.load(data);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

// === STEP 2: Summarize
async function summarizeJob(text) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(`Summarize this job:\n${text}`);
  return result.response.text();
}

// === STEP 3: Create Ultravox Agent
async function createUltravoxAgent(summary) {
  const config = {
    systemPrompt: `You are RecruitAI, an intelligent recruiter bot.\nJob Summary:\n${summary}`,
    model: 'fixie-ai/ultravox',
    temperature: 0.3,
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    voice: 'Mark',
    medium: { twilio: {} },
    selectedTools: [{
      temporaryTool: {
        modelToolName: 'merge_manager',
        description: 'Escalate to human...',
        http: {
          baseUrlPattern: MERGE_SERVER_URL,
          httpMethod: 'POST'
        }
      }
    }]
  };

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': ULTRAVOX_API_KEY
      }
    });

    let data = '';
    req.on('response', res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.joinUrl);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(config));
    req.end();
  });
}

// === TWIML XML Endpoint
app.get('/xml', (req, res) => {
  if (!JOIN_URL) return res.status(503).send('Ultravox agent not ready');
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${JOIN_URL}"/>
      </Connect>
    </Response>
  `);
});

// === TRIGGER CALL VIA EXOTEL
async function callViaExotel(publicUrl) {
  const payload = new URLSearchParams({
    From: EXOPHONE,
    To: CANDIDATE_NUMBER,
    CallerId: EXOPHONE,
    Url: `${publicUrl}/xml`,
    CallType: 'trans'
  });

  const url = `https://${EXOTEL_SID}:${EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/${EXOTEL_SID}/Calls/connect.json`;

  const response = await axios.post(url, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: {
      username: EXOTEL_API_KEY,
      password: EXOTEL_API_TOKEN
    }
  });

  console.log('📞 Exotel call started:', response.data);
}

// === INIT
app.get('/', async (req, res) => {
  try {
    const job = await scrapeJob();
    const summary = await summarizeJob(job);
    JOIN_URL = await createUltravoxAgent(summary);
    console.log('🔗 Ultravox Join URL:', JOIN_URL);

    // Use Render's public URL
    const publicUrl = req.protocol + '://' + req.get('host');
    await callViaExotel(publicUrl);

    res.send('✅ Call initiated!');
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Ultravox + Exotel AI Agent is running on http://localhost:${PORT}`);
});
