const fs = require('fs');

function findChatCode(file) {
  const h = fs.readFileSync(file, 'utf8');
  console.log('=== ' + file + ' ===');
  
  // Find chat-related CSS classes and HTML
  h.split('\n').forEach((l, i) => {
    if (l.match(/chat|Chat|thread|message|Message|start.chat|new.chat/i)) {
      if (l.trim().length > 20) {
        console.log('L' + (i+1) + ': ' + l.trim().substring(0, 150));
      }
    }
  });
  console.log('');
}

findChatCode('buyer.html');
findChatCode('seller.html');
