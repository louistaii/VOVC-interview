const CONFIG = {
    SEND_SAMPLE_RATE: 16000,
    RECEIVE_SAMPLE_RATE: 24000,
    CHANNELS: 1,
    INPUT_CHUNK_SIZE: 1024,
    OUTPUT_CHUNK_SIZE: 2048
};

const state = {
    websocket: null,
    isListening: true,
    isSpeaking: false,
    isTranscribing: false,
    conversationLog: [],
    audioOutputQueue: [],
    shutdownRequested: false,
    liveTranscript: [],
    transcriptionActive: true,
    currentUserBuffer: "",
    currentGeminiBuffer: "",
    lastUserUpdate: 0,
    lastGeminiUpdate: 0,
    bufferTimeout: 2000
};

const elements = {
    setupSection: document.getElementById('setupSection'),
    mainInterface: document.getElementById('mainInterface'),
    apiKey: document.getElementById('apiKey'),
    modelSelect: document.getElementById('modelSelect'),
    voiceSelect: document.getElementById('voiceSelect'),
    initialPrompt: document.getElementById('initialPrompt'),
    promptFile: document.getElementById('promptFile'),
    loadPromptBtn: document.getElementById('loadPromptBtn'),
    clearPromptBtn: document.getElementById('clearPromptBtn'),
    startBtn: document.getElementById('startBtn'),
    statusDisplay: document.getElementById('statusDisplay'),
    recordingIndicator: document.getElementById('recordingIndicator'),
    transcriptBtn: document.getElementById('transcriptBtn'),
    stopBtn: document.getElementById('stopBtn'),
    conversationLog: document.getElementById('conversationLog'),
    transcriptSection: document.getElementById('transcriptSection'),
    transcriptContent: document.getElementById('transcriptContent'),
    downloadTranscript: document.getElementById('downloadTranscript')
};

function showStatus(message, type = 'info') {
    elements.statusDisplay.textContent = message;
    elements.statusDisplay.className = `status status-${type}`;
}

function addMessage(speaker, message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${speaker}: ${message}`;
    state.conversationLog.push(logEntry);
    
    elements.conversationLog.innerHTML = state.conversationLog
        .slice(-10)
        .map(entry => `<div>${entry}</div>`)
        .join('');
    elements.conversationLog.scrollTop = elements.conversationLog.scrollHeight;
}

function addToTranscriptBuffered(speaker, textChunk) {
    if (!state.transcriptionActive) return;
    
    const currentTime = Date.now();
    
    if (speaker === "USER") {
        if (textChunk.trim()) {
            state.currentUserBuffer += textChunk;
            state.lastUserUpdate = currentTime;
        }
    } else if (speaker === "INTERVIEWER") {
        if (textChunk.trim()) {
            state.currentGeminiBuffer += textChunk;
            state.lastGeminiUpdate = currentTime;
        }
    }
}

function finalizeBufferedTranscripts() {
    const currentTime = Date.now();
    
    if (state.currentUserBuffer.trim() && 
        currentTime - state.lastUserUpdate > state.bufferTimeout) {
        addToTranscript("USER", state.currentUserBuffer.trim());
        state.currentUserBuffer = "";
    }
    
    if (state.currentGeminiBuffer.trim() && 
        currentTime - state.lastGeminiUpdate > state.bufferTimeout) {
        addToTranscript("INTERVIEWER", state.currentGeminiBuffer.trim());
        state.currentGeminiBuffer = "";
    }
}

function addToTranscript(speaker, text) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${speaker}: ${text}`;
    state.liveTranscript.push(entry);
    addMessage(speaker, text);
    updateTranscriptDisplay(); 
}

function updateTranscriptDisplay() {
    if (state.liveTranscript.length > 0) {
        elements.transcriptContent.textContent = state.liveTranscript.join('\n');
    }
}

function saveApiKey(key) {
    localStorage.setItem('gemini_api_key', key);
}

function loadApiKey() {
    const saved = localStorage.getItem('gemini_api_key');
    if (saved) {
        elements.apiKey.value = saved;
    }
}

function savePrompt(prompt) {
    localStorage.setItem('gemini_initial_prompt', prompt);
}

function loadPrompt() {
    const saved = localStorage.getItem('gemini_initial_prompt');
    if (saved) {
        elements.initialPrompt.value = saved;
    }
}

function handlePromptChange() {
    const prompt = elements.initialPrompt.value.trim();
    if (prompt) {
        savePrompt(prompt);
    }
}

function loadPromptFromFile() {
    elements.promptFile.click();
}

function handlePromptFile(event) {
    const file = event.target.files[0];
    if (file && file.type === 'text/plain') {
        const reader = new FileReader();
        reader.onload = function(e) {
            elements.initialPrompt.value = e.target.result;
            savePrompt(e.target.result);
            showStatus('✅ Prompt loaded and saved', 'success');
            setTimeout(() => showStatus('Ready to start', 'info'), 2000);
        };
        reader.readAsText(file);
    } else {
        showStatus('❌ Please select a valid .txt file', 'error');
    }
}

function clearPrompt() {
    const defaultPrompt = "";
    elements.initialPrompt.value = defaultPrompt;
    savePrompt(defaultPrompt);
    showStatus('✅ Prompt reset to default', 'success');
    setTimeout(() => showStatus('Ready to start', 'info'), 2000);
}

class AudioManager {
    constructor() {
        this.audioContext = null;
        this.playbackContext = null;
        this.stream = null;
        this.audioOutputBuffer = [];
        this.isPlaying = false;
        this.nextPlayTime = 0;
    }

    async initialize() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: CONFIG.SEND_SAMPLE_RATE,
                    channelCount: CONFIG.CHANNELS,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: CONFIG.SEND_SAMPLE_RATE
            });

            await this.setupPCMCapture();
            return true;
        } catch (error) {
            showStatus('❌ Failed to access microphone', 'error');
            return false;
        }
    }

    async setupPCMCapture() {
        const source = this.audioContext.createMediaStreamSource(this.stream);
        const bufferSize = CONFIG.INPUT_CHUNK_SIZE;
        this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        this.scriptProcessor.onaudioprocess = (event) => {
            if (state.isListening && !state.isSpeaking && !state.isTranscribing) {
                const inputBuffer = event.inputBuffer;
                const channelData = inputBuffer.getChannelData(0);
                
                const pcmBuffer = new ArrayBuffer(channelData.length * 2);
                const pcmView = new Int16Array(pcmBuffer);
                
                for (let i = 0; i < channelData.length; i++) {
                    pcmView[i] = Math.max(-32768, Math.min(32767, Math.round(channelData[i] * 32767)));
                }
                
                this.sendPCMData(pcmBuffer);
            }
        };
        
        source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioContext.destination);
    }

    sendPCMData(pcmBuffer) {
        if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
            try {
                const uint8Array = new Uint8Array(pcmBuffer);
                const binary = Array.from(uint8Array)
                    .map(byte => String.fromCharCode(byte))
                    .join('');
                const base64Data = btoa(binary);

                const message = {
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm",
                            data: base64Data
                        }]
                    }
                };

                state.websocket.send(JSON.stringify(message));
            } catch (error) {
                console.error("Error sending PCM:", error);
            }
        }
    }

    startListening() {
        if (this.audioContext && this.scriptProcessor) {
            elements.recordingIndicator.classList.remove('hidden');
        }
    }

    stopListening() {
        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
            elements.recordingIndicator.classList.add('hidden');
        }
    }

    async playAudio(audioData) {
        try {
            if (!audioData || audioData.byteLength === 0) return;
            if (state.isTranscribing) return;

            this.audioOutputBuffer.push(audioData);
            
            if (!this.isPlaying) {
                this.startContinuousPlayback();
            }
        } catch (error) {
            console.error("Error buffering audio:", error);
        }
    }

    async startContinuousPlayback() {
        if (this.isPlaying) return;
        
        try {
            this.isPlaying = true;
            
            if (!this.playbackContext) {
                this.playbackContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 24000
                });
            }

            if (this.playbackContext.state === 'suspended') {
                await this.playbackContext.resume();
            }

            this.nextPlayTime = this.playbackContext.currentTime;
            this.processAudioBuffer();
        } catch (error) {
            this.isPlaying = false;
        }
    }

    async processAudioBuffer() {
        while (this.isPlaying) {
            if (this.audioOutputBuffer.length > 0) {
                const audioData = this.audioOutputBuffer.shift();
                await this.playAudioChunk(audioData);
            } else {
                await new Promise(resolve => setTimeout(resolve, 200));
                if (this.audioOutputBuffer.length === 0) {
                    this.isPlaying = false;
                    state.isSpeaking = false;
                    break;
                }
            }
        }
    }

    async playAudioChunk(audioData) {
        try {
            // Try standard audio format first
            try {
                const audioBuffer = await this.playbackContext.decodeAudioData(audioData.slice());
                const source = this.playbackContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.playbackContext.destination);
                
                const startTime = Math.max(this.nextPlayTime, this.playbackContext.currentTime);
                source.start(startTime);
                this.nextPlayTime = startTime + audioBuffer.duration;
                
                state.isSpeaking = true;
                return;
            } catch (standardError) {
                // Continue to PCM formats
            }
            
            // Try PCM formats
            const formats = [
                { sampleRate: 24000, format: 'int16' },
                { sampleRate: 16000, format: 'int16' },
                { sampleRate: 22050, format: 'int16' },
                { sampleRate: 8000, format: 'int16' },
                { sampleRate: 24000, format: 'float32' },
                { sampleRate: 24000, format: 'uint8' }
            ];
            
            for (const fmt of formats) {
                try {
                    let audioBuffer;
                    
                    if (fmt.format === 'int16') {
                        if (audioData.byteLength % 2 !== 0) continue;
                        const numSamples = audioData.byteLength / 2;
                        if (numSamples < 10) continue;
                        
                        audioBuffer = this.playbackContext.createBuffer(1, numSamples, fmt.sampleRate);
                        const channelData = audioBuffer.getChannelData(0);
                        const pcmData = new Int16Array(audioData);
                        
                        for (let i = 0; i < numSamples; i++) {
                            channelData[i] = pcmData[i] / 32768.0;
                        }
                    } else if (fmt.format === 'float32') {
                        if (audioData.byteLength % 4 !== 0) continue;
                        const numSamples = audioData.byteLength / 4;
                        if (numSamples < 10) continue;
                        
                        audioBuffer = this.playbackContext.createBuffer(1, numSamples, fmt.sampleRate);
                        const channelData = audioBuffer.getChannelData(0);
                        const floatData = new Float32Array(audioData);
                        
                        for (let i = 0; i < numSamples; i++) {
                            channelData[i] = floatData[i];
                        }
                    } else if (fmt.format === 'uint8') {
                        const numSamples = audioData.byteLength;
                        if (numSamples < 10) continue;
                        
                        audioBuffer = this.playbackContext.createBuffer(1, numSamples, fmt.sampleRate);
                        const channelData = audioBuffer.getChannelData(0);
                        const uint8Data = new Uint8Array(audioData);
                        
                        for (let i = 0; i < numSamples; i++) {
                            channelData[i] = (uint8Data[i] - 128) / 128.0;
                        }
                    }
                    
                    const source = this.playbackContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(this.playbackContext.destination);
                    
                    const startTime = Math.max(this.nextPlayTime, this.playbackContext.currentTime);
                    source.start(startTime);
                    this.nextPlayTime = startTime + audioBuffer.duration;
                    
                    state.isSpeaking = true;
                    break;
                } catch (pcmError) {
                    continue;
                }
            }
        } catch (error) {
            console.error("Error playing audio chunk:", error);
        }
    }
}

class GeminiLiveClient {
    constructor(apiKey, voice, model, systemPrompt) {
        this.apiKey = apiKey;
        this.voice = voice;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.audioManager = new AudioManager();
    }

    async connect() {
        try {
            showStatus('🔄 Connecting to Gemini Live...', 'info');

            const audioReady = await this.audioManager.initialize();
            if (!audioReady) return false;

            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
            state.websocket = new WebSocket(wsUrl);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, 10000);

                state.websocket.onopen = () => {
                    clearTimeout(timeout);
                    
                    const setupMessage = {
                        setup: {
                            model: this.model,
                            generationConfig: {
                                responseModalities: ["AUDIO"],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: {
                                            voiceName: this.voice
                                        }
                                    }
                                }
                            },
                            inputAudioTranscription: {},
                            outputAudioTranscription: {}
                        }
                    };

                    state.websocket.send(JSON.stringify(setupMessage));

                    showStatus('✅ Connected! Start talking...', 'success');
                    addMessage('SYSTEM', 'Assistant connected with live transcription');

                    setTimeout(() => {
                        this.sendInitialPrompt();
                    }, 1000);

                    this.startListening();
                    this.setupMessageHandling();

                    resolve(true);
                };

                state.websocket.onerror = (error) => {
                    clearTimeout(timeout);
                    showStatus('❌ Connection failed', 'error');
                    reject(error);
                };

                state.websocket.onclose = (event) => {
                    if (event.code === 1000) {
                        showStatus('🔌 Session ended normally', 'info');
                    } else if (event.code === 1006) {
                        showStatus('❌ Connection lost unexpectedly', 'error');
                    } else if (event.code === 1007) {
                        showStatus('❌ Invalid audio format sent', 'error');
                    } else if (event.code === 1008) {
                        showStatus('❌ Policy violation or invalid API key', 'error');
                    } else {
                        showStatus(`❌ Connection closed (${event.code})`, 'error');
                    }
                };
            });
        } catch (error) {
            showStatus('❌ Connection failed: ' + error.message, 'error');
            return false;
        }
    }

    async sendInitialPrompt() {
        try {
            if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                const initialMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{
                                text: this.systemPrompt
                            }]
                        }],
                        turnComplete: true
                    }
                };

                state.websocket.send(JSON.stringify(initialMessage));
                addMessage('SYSTEM', 'Initial prompt sent - AI should respond soon');
            }
        } catch (error) {
            console.error("Error sending initial prompt:", error);
        }
    }

    setupMessageHandling() {
        state.websocket.onmessage = async (event) => {
            try {
                if (typeof event.data === 'string') {
                    const data = JSON.parse(event.data);
                    this.handleJsonData(data);
                    return;
                }

                if (event.data instanceof ArrayBuffer) {
                    const firstBytes = new Uint8Array(event.data.slice(0, 4));
                    const isJson = firstBytes[0] === 0x7b;
                    
                    if (isJson) {
                        const jsonString = new TextDecoder().decode(event.data);
                        const data = JSON.parse(jsonString);
                        this.handleJsonData(data);
                        return;
                    }
                    
                    await this.audioManager.playAudio(event.data);
                    return;
                }

                if (event.data instanceof Blob) {
                    const sample = await event.data.slice(0, 10).text();
                    if (sample.trim().startsWith('{')) {
                        const jsonText = await event.data.text();
                        const data = JSON.parse(jsonText);
                        this.handleJsonData(data);
                        return;
                    }
                    
                    const arrayBuffer = await event.data.arrayBuffer();
                    await this.audioManager.playAudio(arrayBuffer);
                    return;
                }
            } catch (error) {
                console.error("Error handling message:", error);
            }
        };
    }

    handleJsonData(data) {
        if (data.serverContent) {
            if (data.serverContent.inputTranscription && data.serverContent.inputTranscription.text) {
                const userText = data.serverContent.inputTranscription.text;
                if (userText.trim()) {
                    addToTranscriptBuffered("USER", userText);
                }
            }
            
            if (data.serverContent.outputTranscription && data.serverContent.outputTranscription.text) {
                const geminiText = data.serverContent.outputTranscription.text;
                if (geminiText.trim()) {
                    addToTranscriptBuffered("INTERVIEWER", geminiText);
                }
            }
            
            if (data.serverContent.modelTurn && data.serverContent.modelTurn.parts) {
                for (const part of data.serverContent.modelTurn.parts) {
                    if (part.text) {
                        addMessage('AI', part.text);
                    }
                    
                    if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.includes('audio')) {
                        try {
                            const binaryString = atob(part.inlineData.data);
                            const audioArray = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                audioArray[i] = binaryString.charCodeAt(i);
                            }
                            this.audioManager.playAudio(audioArray.buffer);
                        } catch (audioError) {
                            console.error("Error decoding audio:", audioError);
                        }
                    }
                }
            }
        }
    }

    startListening() {
        this.audioManager.startListening();
        state.isListening = true;
        
        this.bufferMonitorInterval = setInterval(() => {
            try {
                finalizeBufferedTranscripts();
            } catch (error) {
                console.error("Buffer monitor error:", error);
            }
        }, 500);
    }

    stop() {
        state.shutdownRequested = true;
        state.isListening = false;
        
        if (this.bufferMonitorInterval) {
            clearInterval(this.bufferMonitorInterval);
        }
        
        if (state.currentUserBuffer.trim()) {
            addToTranscript("USER", state.currentUserBuffer.trim());
            state.currentUserBuffer = "";
        }
        
        if (state.currentGeminiBuffer.trim()) {
            addToTranscript("INTERVIEWER", state.currentGeminiBuffer.trim());
            state.currentGeminiBuffer = "";
        }
        
        if (this.audioManager) {
            this.audioManager.stopListening();
        }
        
        if (state.websocket) {
            state.websocket.close();
            state.websocket = null;
        }
        
        showStatus('🔚 Session ended', 'info');
    }
}

class VoiceInterviewer {
    constructor() {
        this.client = null;
    }

    async start() {
        const apiKey = elements.apiKey.value.trim();
        const voice = elements.voiceSelect.value;
        const model = elements.modelSelect.value;
        const systemPrompt = elements.initialPrompt.value.trim();

        if (!apiKey) {
            showStatus('❌ Please enter your Gemini API key', 'error');
            return false;
        }

        saveApiKey(apiKey);

        this.client = new GeminiLiveClient(apiKey, voice, model, systemPrompt);
        const connected = await this.client.connect();

        if (connected) {
            elements.setupSection.classList.add('hidden');
            elements.mainInterface.classList.remove('hidden');
            return true;
        }

        return false;
    }

    stop() {
        if (this.client) {
            this.client.stop();
        }
        
        elements.setupSection.classList.remove('hidden');
        elements.mainInterface.classList.add('hidden');
        elements.transcriptSection.classList.add('hidden');
        elements.conversationLog.innerHTML = '';
        
        state.conversationLog = [];
        state.liveTranscript = [];
        state.currentUserBuffer = "";
        state.currentGeminiBuffer = "";
        state.shutdownRequested = false;
        this.client = null;
    }

    downloadTranscript() {
        let transcript = '';
        if (state.liveTranscript.length > 0) {
            transcript = state.liveTranscript.join('\n');
        } else {
            transcript = elements.transcriptContent.textContent;
        }
        
        if (!transcript) {
            showStatus('❌ No transcript to download', 'error');
            return;
        }

        const blob = new Blob([transcript], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transcript_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

const app = new VoiceInterviewer();
loadApiKey();
loadPrompt();

// Prompt auto-save functionality
let promptSaveTimeout;
elements.initialPrompt.addEventListener('input', () => {
    clearTimeout(promptSaveTimeout);
    promptSaveTimeout = setTimeout(() => {
        handlePromptChange();
    }, 1000);
});

elements.initialPrompt.addEventListener('blur', handlePromptChange);

// File upload handling
elements.loadPromptBtn.addEventListener('click', loadPromptFromFile);
elements.clearPromptBtn.addEventListener('click', clearPrompt);
elements.promptFile.addEventListener('change', handlePromptFile);

elements.startBtn.addEventListener('click', async () => {
    elements.startBtn.disabled = true;
    elements.startBtn.textContent = '🔄 Starting...';

    try {
        await app.start();
    } catch (error) {
        showStatus('❌ Failed to start: ' + error.message, 'error');
    }
    
    elements.startBtn.disabled = false;
    elements.startBtn.textContent = '🚀 Start Voice Interview';
});

elements.transcriptBtn.addEventListener('click', () => {
    elements.transcriptSection.classList.toggle('hidden');
    if (!elements.transcriptSection.classList.contains('hidden')) {
        showStatus('📋 Live transcript displayed', 'success');
    }
});

elements.stopBtn.addEventListener('click', () => {
    app.stop();
});

elements.downloadTranscript.addEventListener('click', () => {
    app.downloadTranscript();
});

window.addEventListener('beforeunload', () => {
    app.stop();
});

document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'q' && !event.target.matches('input, textarea')) {
        event.preventDefault();
        app.stop();
    }
});