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
  PORT = 3000,
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

// === STEP 1: Scrape Job Description
async function scrapeJob() {
  console.log('🌐 Scraping job description...');
  const { data } = await axios.get(JOB_DESC_URL);
  const $ = cheerio.load(data);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

// === STEP 2: Summarize Job Description via Gemini
async function summarizeJob(text) {
  console.log('🧠 Summarizing job with Gemini...');
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(`Summarize this job:\n${text}`);
  return result.response.text();
}

// === STEP 3: Create Ultravox Agent
async function createUltravoxAgent(summary) {
  console.log('🤖 Creating Ultravox agent...');
  const config = {
    systemPrompt: `You are RecruitAI, an intelligent recruiter bot.\nJob Summary:\n${summary}`,
    model: 'fixie-ai/ultravox',
    temperature: 0.3,
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    voice: 'Mark',
    medium: { twilio: {} },
    selectedTools: [
      {
        temporaryTool: {
          modelToolName: 'merge_manager',
          description: 'Escalate to human...',
          http: {
            baseUrlPattern: MERGE_SERVER_URL,
            httpMethod: 'POST'
          }
        }
      }
    ]
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
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.joinUrl);
        } catch (err) {
          reject(new Error('Failed to parse Ultravox response: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(config));
    req.end();
  });
}

// === STEP 4: Return TwiML to Exotel
app.get('/xml', (req, res) => {
  if (!JOIN_URL) {
    return res.status(503).send('<Response><Say>Agent not ready yet</Say></Response>');
  }

  console.log('📨 Exotel requested XML with JOIN_URL:', JOIN_URL);
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="${JOIN_URL}" />
      </Connect>
    </Response>
  `);
});

// === STEP 5: Initiate Call via Exotel
async function callViaExotel(publicUrl) {
  console.log('📞 Triggering call via Exotel...');

  const payload = new URLSearchParams({
    From: EXOPHONE,
    To: CANDIDATE_NUMBER,
    CallerId: EXOPHONE,
    Url: `${publicUrl}/xml`,
    CallType: 'trans'
  });

  const url = `https://${EXOTEL_SID}:${EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/${EXOTEL_SID}/Calls/connect.json`;

  const response = await axios.post(url, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    auth: {
      username: EXOTEL_API_KEY,
      password: EXOTEL_API_TOKEN
    }
  });

  console.log('✅ Exotel response:', response.data);
}

// === Entry Route: Full Agent Lifecycle
app.get('/', async (req, res) => {
  try {
    const jobText = await scrapeJob();
    const jobSummary = await summarizeJob(jobText);
    JOIN_URL = await createUltravoxAgent(jobSummary);
    console.log('🔗 JOIN_URL:', JOIN_URL);

    const publicUrl = `${req.protocol}://${req.get('host')}`;
    await callViaExotel(publicUrl);

    res.send('✅ Call initiated successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).send({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
