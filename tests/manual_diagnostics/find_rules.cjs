const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const rules = db.aiKnowledgeBase || [];

console.log('=== RULE DEFINITIONS IN DATABASE ===');
const ruleIdsToFind = ['adv_2', 'adv_20', 'adv_14', 'adv_1', 'adv_13', 'adv_22', 'adv_3', 'adv_23', 'adv_19', 'adv_4'];

ruleIdsToFind.forEach(id => {
  const rule = rules.find(r => r.id === id);
  if (rule) {
    console.log(`\n--- ID: ${rule.id} | Agent: ${rule.agent} ---`);
    console.log(`Text: ${rule.text}`);
    console.log(`Indicator: ${rule.filterIndicator} | Condition: ${rule.filterCondition} | Value: ${rule.filterValue} | Action: ${rule.filterAction}`);
  } else {
    console.log(`\nRule ID ${id} not found in database.`);
  }
});
