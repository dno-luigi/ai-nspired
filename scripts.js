const API_URL = 'https://justice.ai-n.workers.dev/api/ai/truth';
const modalOverlay = document.getElementById('modal-overlay');
const closeModalBtn = document.getElementById('close-modal');
const queryInput = document.getElementById('queryInput');
const searchButton = document.getElementById('searchButton');
const resultContainer = document.getElementById('resultContainer');

// Format Markdown functions
function formatMarkdown(text) {
  // Basic formatting for headers, lists, etc.
  if (text.includes('## ')) {
    const headerText = text.split('## ')[1]?.split('\n')[0] || '';
    text = `<div class="markdown-heading">${headerText}</div>` + '\n' + 
           text.replace('## ', '<p class="markdown-text">• ');
  } else if (text.includes('### ')) {
    const headerText = text.split('### ')[1]?.split('\n')[0] || '';
    text = `<div class="markdown-heading-2">${headerText}</div>` + '\n' + 
           text.replace('### ', '<p class="markdown-text">• ');
  }
  
  // Format lists
  if (text.includes('\n- ') || text.includes('\n• ')) {
    const listItems = text.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('•'));
    const regex = /(^\s*([-•]\s+.+))|([^-\n]+)\n/g;
    text = text.replace(regex, 
      (match) => {
        const cleanText = match.replace(/^[-•]\s+/, '').trim();
        return `<li class="markdown-list-item">${cleanText}</li>`;
      }).replace(/\n/g, '');
    
    text = `<ul class="markdown-list">${text}</ul>`;
  }
  
  // Basic formatting for links
  text = text.replace(/\[([^\[]+)\]\(([^\)]+)\)/g, '<a class="markdown-link" href="$2">$1</a>');
  
  // Format code
  if (text.includes('`') {
    // Very basic code formatting - assumes triple backticks for code blocks
    if (text.includes('```\n')) {
      const codeBlocks = text.split('```\n');
      let formatted = '';
      for (let i = 0; i < codeBlocks.length; i++) {
        if (i % 2 === 0) {
          const codeContent = codeBlocks[i].replace(/`/g, '');
          formatted += `<pre class="markdown-code">${codeContent.replace(/\n/g, '<br>')}</pre>`;
        } else {
          if (i !== codeBlocks.length - 1) {
            formatted += `<div class="markdown-text">${codeBlocks[i]}</div>`;
          }
        }
      }
      text = formatted;
    } else {
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    }
  }
  
  // Format quoted text (looking for "> ")
  text = text.replace(/^>\s+(.*)$/gm, '<blockquote class="markdown-quote">» $1</blockquote>');
  
  return `<div class="markdown-body">${text}</div>`;
}

// Modal Controls
function closeModal() {
  modalOverlay.classList.remove('active');
  document.body.style.overflow = 'auto';
}

function openModal(initialQuery = '') {
  modalOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  queryInput.value = initialQuery;
  if (initialQuery) performTruthQuery();
  else queryInput.focus();
}

// Event Listeners
closeModalBtn.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

searchButton.addEventListener('click', performTruthQuery);
queryInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') performTruthQuery();
});

document.querySelectorAll('[data-search]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    openModal(el.dataset.search);
  });
});

// API Functions
async function performTruthQuery() {
  const query = queryInput.value.trim();
  resultContainer.innerHTML = '';

  if (!query) {
    resultContainer.innerHTML = '<p class="error">Enter a question to initiate search protocol</p>';
    return;
  }

  resultContainer.innerHTML = '<p class="search-status">⚡ Scanning truth matrix...</p>';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    
    let resultHTML = '';
    
    if (data.answer) {
      // Format the answer as Markdown
      const formattedAnswer = formatMarkdown(data.answer);
      resultHTML = `
        <div class="markdown-section">
          <div class="markdown-heading">Response Analysis</div>
          ${formattedAnswer}
        </div>
      `;

      if (data.citations && Array.isArray(data.citations) && data.citations.length) {
        resultHTML += `
          <div class="citation-block">
            <div class="markdown-heading">Source Verification</div>
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
          <div class="markdown-heading">Search Engine Error</div>
          <p>${data.error}</p>
        </div>
      `;
    } else {
      resultHTML = `
        <div class="search-results">
          <div class="markdown-heading">Search Results</div>
          <p>No definitive patterns found in our database. Refine your query parameters for better results.</p>
        </div>
      `;
    }

    resultContainer.innerHTML = resultHTML;
  } catch (error) {
    resultContainer.innerHTML = `
      <div class="error-section">
        <div class="markdown-heading">System Error</div>
        <p>Query failed: ${error.message}</p>
      </div>
    `;
  }
}
