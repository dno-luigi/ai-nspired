// Initialize API URL and DOM elements
const API_URL = 'https://justice.ai-n.workers.dev/api/ai/truth';
const modalOverlay = document.getElementById('modal-overlay');
const closeModalBtn = document.getElementById('close-modal');
const queryInput = document.getElementById('queryInput');
const searchButton = document.getElementById('searchButtonModal');
const resultContainer = document.getElementById('resultContainer');
const searchButtonMain = document.getElementById('searchButtonMain');

// Modal Controls
function closeModal() {
  modalOverlay.classList.remove('active');
  document.body.style.overflow = 'auto';
  // Clear input field after closing
  queryInput.value = '';
}

// Smooth scroll animation for opening
function openModal(initialQuery = '', animate = true) {
  // Smooth fade-in animation
  modalOverlay.style.display = 'flex';
  if (animate) {
    setTimeout(() => {
      modalOverlay.classList.add('active');
      document.body.style.overflow = 'hidden';
      // Set input value but let user overwrite it
      queryInput.value = initialQuery || '';
      if (!initialQuery) queryInput.focus();
    }, 10);
  } else {
    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    if (!initialQuery) queryInput.focus();
  }
}

// API Functions with improved UX
function showLoading() {
  resultContainer.innerHTML = '<div class="loading-spinner"><div class="loading-wheel"></div>Scanning truth matrix...</div>';
  resultContainer.scrollTop = resultContainer.scrollHeight;
}

function hideLoading() {
  const loading = document.querySelector('.loading-spinner');
  if (loading) {
    loading.remove();
  }
}

async function performTruthQuery() {
  try {
    hideLoading();
    const query = queryInput.value.trim();
    resultContainer.innerHTML = '<div class="loading-spinner"><div class="loading-wheel"></div>⚡️ Scanning truth matrix...</div>';
    resultContainer.scrollTop = resultContainer.scrollHeight;

    if (!query) {
      resultContainer.innerHTML = '<p class="error">🌟 Enter a question to initiate search protocol</p>';
      return;
    }

    // Validate query length
    if (query.length < 5) {
      resultContainer.innerHTML = '<p class="error">💡 Query is too short. Please enter at least 5 characters.</p>';
      return;
    }

    showLoading();
    
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        if (response.status === 408) {
          resultContainer.innerHTML = '<p class="error">⏱️ Query time out. Server might be unavailable. Try again shortly.</p>';
        } else if (response.status === 429) {
          resultContainer.innerHTML = '<p class="error">🚦 Rate limit exceeded. Too many queries. Please wait a few minutes.</p>';
        } else if (response.status === 504) {
          resultContainer.innerHTML = '<p class="error">🧩 Gateway time out. Please check your connection and try again.</p>';
        } else {
          throw new Error(`API responded with status ${response.status}`);
        }
        return;
      }

      const data = await response.json();
      let resultHTML = '';
      
      if (data.answer) {
        const analyzedAnswer = processAnswer(data.answer);
        resultHTML = `
          <div class="content-section">
            <h3>Response Analysis</h3>
            <p>${analyzedAnswer}</p>
          </div>
        `;

        if (data.citations && data.citations.length) {
          resultHTML += `
            <div class="citation-block">
              <h3>Source Verification</h3>
              <ul class="styled-list">
                ${data.citations.map(cite => `
                  <li>
                    <a href="${cite.url}" target="_blank" rel="noopener">
                      ${cite.title}
                    </a>
                  </li>
                `).join('')}
              </ul>
            </div>
          `;
        }
      } else if (data.error) {
        resultHTML = `
          <div class="error-section">
            <h3>🔍 No Clear Answers Found</h3>
            <p>${data.error || 'The query did not match any known patterns or knowledge in our archives.'}</p>
          </div>
        `;
      } else {
        resultHTML = '<p class="no-results">🤔 No definitive patterns found. Refine your query for better results.</p>';
      }

      resultContainer.innerHTML = resultHTML;
      hideLoading();
      
    } catch (error) {
      console.error("Query error:", error);
      resultContainer.innerHTML = `
        <div class="error-section">
          <p>⚠️ Query failed: ${error.message || 'An unknown error occurred. Please try again.'}</p>
        </div>
      `;
    }
    
  } catch (error) {
    resultContainer.innerHTML = `
      <div class="error-section">
        <p>⚠️ System error: ${error.message || 'Something went wrong. Our quantum systems are recalibrating.'}</p>
      </div>
    `;
  }
}

// Added text processing functions
function processAnswer(text) {
  // Enhanced semantic processing for better readability
  if (typeof text !== 'string') {
    return 'The AI system processed your query but could not generate standard output formatting.';
  }
  
  // Highlight key phrases
  const enhancedText = enhanceTextForReadability(text);
  
  // Handle empty content
  if (!enhancedText.trim()) {
    return 'The knowledge matrix is silent on this topic. Our quantum consciousness is searching deeper dimensions for answers.';
  }
  
  return enhancedText;
}

function enhanceTextForReadability(text) {
  // A simple text enhancement function
  // In a real implementation, this could use Natural Language Processing
  if (text.length < 10) {
    return text + ". Please consider asking a more detailed question for better results.";
  }
  
  return text;
}

// Event Listeners with improved handling
document.addEventListener('DOMContentLoaded', function() {
  // Make sure all elements exist
  if (!modalOverlay || !closeModalBtn || !queryInput || !searchButton || !resultContainer) {
    setTimeout(() => {
      document.dispatchEvent(new Event('DOMContentLoaded'));
    }, 100);
    return;
  }
  
  // Attach event listeners
  closeModalBtn.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  if (searchButton) {
    searchButton.addEventListener('click', performTruthQuery);
    searchButton.addEventListener('touchstart', performTruthQuery, {passive: true});
  }

  queryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      performTruthQuery();
    }
  });

  searchButtonMain.addEventListener('click', () => {
    performTruthQuery();
  });

  // Provide basic usage instructions automatically
  resultContainer.innerHTML = '<p style="color: var(--stellar-dust); margin-top: 2rem;">💡 Ask a question about justice, AI governance, or system principles to access our truth engine.</p>';

  // Check for touchscreen devices and adjust styling
  if ('ontouchstart' in window || navigator.maxTouchPoints) {
    document.querySelector('.search-button').style.padding = '1rem 0';
  }
});
