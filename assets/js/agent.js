/* AI Agent Logic - NOMAD (Jane 3.0: Video-powered Talking Head) */
(function() {
    const AGENT_NAME = "Jane";
    const FALLBACK_IMAGE = "assets/img/agent_jane_v4.png";
    const VIDEO_URL = "assets/f_ba_mp_.mp4"; 
    const STORAGE_KEY = "nomad_agent_last_seen";
    const GROQ_API_KEY = "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";

    let isSpeaking = false;
    let synth = window.speechSynthesis;
    let currentUtterance = null;
    let unlocked = false; // Browser audio unlock flag
    let video = null; // Global reference within closure
    let hasPlayedVideo = false; // Flag to play video only once
    let isVideoReady = false;

    function initAgent() {
        // Create container
        const container = document.createElement('div');
        container.className = 'agent-container';
        container.id = 'nomadAgent';
        container.innerHTML = `
            <div class="agent-card" id="agentCard">
                <button class="agent-close" id="agentClose">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="agent-header">
                    <h3>${AGENT_NAME}</h3>
                    <span class="badge">IA Generativa</span>
                </div>
                <div class="agent-content" id="agentContent">
                    <p id="agentText">¡Hola! Toca mi avatar para comenzar la experiencia interactiva.</p>
                    <div class="waveform" id="agentWaveform">
                        <div class="waveform-bar"></div>
                        <div class="waveform-bar"></div>
                        <div class="waveform-bar"></div>
                        <div class="waveform-bar"></div>
                        <div class="waveform-bar"></div>
                    </div>
                </div>
                <div class="agent-actions" id="agentActions">
                    <button class="agent-btn" id="agentBtnAsk">
                        <i class="fa-solid fa-comment-dots"></i>&nbsp;Conversar con Jane
                    </button>
                    <button class="agent-btn ghost" id="agentBtnQuote">
                        <i class="fa-solid fa-file-invoice-dollar"></i>&nbsp;Cotizar ahora
                    </button>
                </div>
                <div class="agent-input-container" id="agentInputContainer" style="display: none;">
                    <input type="text" id="agentInput" placeholder="Escribe tu mensaje..." autocomplete="off">
                    <button id="agentSend"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
            </div>
            <div class="agent-avatar-trigger" id="agentTrigger" title="Haz clic para hablar con Jane">
                <video id="agentVideo" src="${VIDEO_URL}" playsinline muted poster="${FALLBACK_IMAGE}" style="display: block; width: 100%; height: 100%; object-fit: cover;"></video>
            </div>
        `;

        document.body.appendChild(container);

        video = document.getElementById('agentVideo');
        const trigger = document.getElementById('agentTrigger');
        const card = document.getElementById('agentCard');
        const close = document.getElementById('agentClose');
        const btnAsk = document.getElementById('agentBtnAsk');
        const btnQuote = document.getElementById('agentBtnQuote');

        // Start video in neutral loop
        if (VIDEO_URL && video) {
            video.muted = true;
            video.loop = false;
            video.playsInline = true;
            video.play().catch(e => console.warn("Autoplay blocked"));
        } else if (video) {
            video.style.display = 'none';
        }

        trigger.addEventListener('click', () => {
            if (!unlocked) {
                unlocked = true;
                initialGreeting();
            }
            toggleCard();
        });

        close.addEventListener('click', (e) => {
            e.stopPropagation();
            hideCard();
            stopSpeaking();
        });

        btnQuote.addEventListener('click', () => {
            if (window.setScreen) window.setScreen('quote');
            hideCard();
            stopSpeaking();
        });

        btnAsk.addEventListener('click', () => {
            showInput();
        });

        const input = document.getElementById('agentInput');
        const sendBtn = document.getElementById('agentSend');

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleMessage();
        });

        sendBtn.addEventListener('click', handleMessage);

        async function handleMessage() {
            const val = input.value.trim();
            if (!val) return;
            input.value = '';
            await askJane(val);
        }

        function showInput() {
            document.getElementById('agentActions').style.display = 'none';
            document.getElementById('agentInputContainer').style.display = 'flex';
            input.focus();
        }

        // Show card after delay
        setTimeout(() => {
            showCard();
        }, 2000);

        // Disabling JS animation loop as it clashes with video
        // animateAvatar();
    }

    function animateAvatar() {
        const trigger = document.getElementById('agentTrigger');
        let angle = 0;
        
        function step() {
            angle += 0.05;
            const y = Math.sin(angle) * 5;
            const s = 1 + Math.cos(angle * 0.5) * 0.02;
            const r = Math.sin(angle * 0.3) * 2;
            
            if (trigger) {
                trigger.style.transform = `translateY(${y}px) scale(${s}) rotate(${r}deg)`;
            }
            requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function toggleCard() {
        const card = document.getElementById('agentCard');
        if (card.classList.contains('show')) {
            hideCard();
            stopSpeaking();
        } else {
            showCard();
        }
    }

    function showCard() {
        const card = document.getElementById('agentCard');
        card.classList.add('show');
        localStorage.setItem(STORAGE_KEY, Date.now());
    }

    function getCatalogContext() {
        if (!window.NOMAD_STATE || !window.NOMAD_STATE.catalog) return "";
        const items = window.NOMAD_STATE.catalog.slice(0, 30); // Top 30 items
        let ctx = "\nESTUDIOS DISPONIBLES EN NOMAD (Usa estos IDs exactos):\n";
        items.forEach(it => {
            ctx += `- ${it.name} (ID: ${it.id}): $${it.price} MXN. ${it.desc}\n`;
        });
        return ctx;
    }

    function hideCard() {
        const card = document.getElementById('agentCard');
        card.classList.remove('show');
    }

    async function initialGreeting() {
        let doctorName = "Doctor(a)";
        
        if (window.NOMAD_FIRE && window.NOMAD_FIRE.getProfileContext) {
            const ctx = window.NOMAD_FIRE.getProfileContext();
            if (ctx.ownerName) doctorName = ctx.ownerName;
        }

        const prompt = `¡Hola, ${doctorName}! Soy Jane, su asistente virtual de NOMAD. Es un placer saludarle. Dígame, ¿qué desea realizar hoy?`;
        
        const textElement = document.getElementById('agentText');
        textElement.textContent = prompt;
        speak(prompt);
    }

    async function handleVoiceInteraction() {
        // Obsolete, replaced by inline input
    }

    async function askJane(userPrompt) {
        const textElement = document.getElementById('agentText');
        const waveform = document.getElementById('agentWaveform');
        const video = document.getElementById('agentVideo');

        textElement.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div><p style="font-size:11px; opacity:0.5; margin-top:5px;">Jane está pensando...</p>';
        waveform.classList.add('show'); 

        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        {
                            role: "system",
                            content: `Eres Jane, la asistente virtual de NOMAD. Eres profesional, empática y sumamente servicial. 
                            Tu objetivo es ayudar a médicos con estudios genéticos y oncológicos. 
                            Habla siempre en español de México. Sé breve pero muy interactiva.
                            ${getCatalogContext()}
                            REGLAS CRÍTICAS:
                            1. Si el usuario solicita cotizar o agregar un estudio, responde confirmando y agrega al final de tu mensaje el comando exacto: [[ADD_CART:id-del-estudio]]
                            2. Usa SIEMPRE los precios de la lista anterior.
                            3. Si el estudio no está en la lista, dile que puede buscarlo en el catálogo.`
                        },
                        {
                            role: "user",
                            content: userPrompt
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 250
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error("Groq API Error:", response.status, errorData);
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            let reply = data.choices[0].message.content;

            // Parse Action Commands
            const cartMatch = reply.match(/\[\[ADD_CART:(.+?)\]\]/);
            if (cartMatch && window.NOMAD_STATE) {
                const studyId = cartMatch[1].trim();
                window.NOMAD_STATE.cart.add(studyId);
                if (window.renderQuote) window.renderQuote();
                if (window.renderCatalog) window.renderCatalog();
                if (window.NOMAD_TOAST) window.NOMAD_TOAST(`🛒 ${studyId} agregado a tu cotización`);
                
                // Clean the tag from the visible reply
                reply = reply.replace(/\[\[ADD_CART:.+?\]\]/g, "").trim();
            }

            textElement.innerHTML = ""; // Limpiar antes de poner la respuesta
            textElement.textContent = reply;
            speak(reply);
        } catch (error) {
            console.error("Jane Interaction Error:", error);
            textElement.innerHTML = `Lo siento, tuve un error técnico. <br><small style='opacity:0.5'>(${error.message})</small>`;
            waveform.classList.remove('show');
        }
    }

    function speak(text) {
        stopSpeaking();

        // We use the video's original audio and playback for the interaction
        const trigger = document.getElementById('agentTrigger');
        const waveform = document.getElementById('agentWaveform');

        if (video && video.src) {
            video.muted = false;
            video.currentTime = 0;
            
            video.onplay = () => {
                isSpeaking = true;
                trigger.classList.add('speaking');
                waveform.classList.add('show');
                console.log("Jane is speaking (Video)...");
            };

            video.onended = () => {
                isSpeaking = false;
                trigger.classList.remove('speaking');
                waveform.classList.remove('show');
                video.muted = true; 
            };

            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.catch(err => {
                    console.error("Video play error:", err);
                    // Fallback to text only if video fails
                    isSpeaking = true;
                    trigger.classList.add('speaking');
                    waveform.classList.add('show');
                    setTimeout(() => {
                        isSpeaking = false;
                        trigger.classList.remove('speaking');
                        waveform.classList.remove('show');
                    }, 4000);
                });
            }
        } else {
            // Subsequent interactions: Only show waveform and text
            isSpeaking = true;
            trigger.classList.add('speaking');
            waveform.classList.add('show');
            
            // Auto-stop 'speaking' state after a delay (simulating speech length)
            const estimatedDuration = Math.min(Math.max(text.length * 50, 2000), 6000);
            setTimeout(() => {
                isSpeaking = false;
                trigger.classList.remove('speaking');
                waveform.classList.remove('show');
            }, estimatedDuration);
        }
    }

    function stopSpeaking() {
        if (synth && synth.speaking) {
            synth.cancel();
        }
        const trigger = document.getElementById('agentTrigger');
        const waveform = document.getElementById('agentWaveform');
        if (trigger) trigger.classList.remove('speaking');
        if (waveform) waveform.classList.remove('show');
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAgent);
    } else {
        initAgent();
    }
})();
