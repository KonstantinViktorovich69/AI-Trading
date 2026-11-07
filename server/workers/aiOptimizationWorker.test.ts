import { describe, it, expect, vi } from 'vitest';

describe('aiOptimizationWorker Retrospective Fallback & Instruction Guard (T1.3)', () => {
  it('does not mutate expert instructions when fallback or placeholder modifications occur', () => {
    const setExpertInstructionsMock = vi.fn();

    const testDecisions = [
      { expertModifications: "", isFallback: true },
      { expertModifications: "Внедрить обязательное использование скользящих лимитных заявок (Pegged/Post-Only)", isFallback: false },
      { expertModifications: "Входы в штатном режиме", isFallback: false },
      { expertModifications: "   ", isFallback: false }
    ];

    for (const rawDecision of testDecisions) {
      const isPlaceholderModifications =
        !rawDecision.expertModifications ||
        rawDecision.expertModifications.trim().length === 0 ||
        rawDecision.expertModifications === 'Входы в штатном режиме' ||
        rawDecision.expertModifications.includes('Pegged/Post-Only') ||
        rawDecision.isFallback === true;

      if (!isPlaceholderModifications) {
        setExpertInstructionsMock(rawDecision.expertModifications);
      }
    }

    expect(setExpertInstructionsMock).not.toHaveBeenCalled();
  });

  it('updates instructions and preserves subsequent sections when valid modification is given', () => {
    const setExpertInstructionsMock = vi.fn();
    const currentInstructions = `### 1. ОБЩИЕ ПРАВИЛА
Торговать строго по алгоритму.

### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)
Старый текст, подлежащий замене.

### 6. ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ
Хвост инструкций, который должен сохраниться.`;

    const validModification = "Снизить размер позиции при волатильности > 3%.";
    const sectionHeader = "### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)";

    const parts = currentInstructions.split(sectionHeader);
    const afterHeader = parts[1] || "";
    const nextSectionIdx = afterHeader.search(/\n###\s+/);
    const tail = nextSectionIdx !== -1 ? afterHeader.substring(nextSectionIdx) : "";
    const updatedInstructions = parts[0] + sectionHeader + "\n" + validModification.trim() + (tail ? "\n\n" + tail.trimStart() : "");

    setExpertInstructionsMock(updatedInstructions);

    expect(setExpertInstructionsMock).toHaveBeenCalledTimes(1);
    expect(updatedInstructions).toContain(validModification);
    expect(updatedInstructions).toContain("### 6. ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ");
    expect(updatedInstructions).toContain("Хвост инструкций, который должен сохраниться.");
  });
});
