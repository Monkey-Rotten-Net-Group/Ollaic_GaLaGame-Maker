/**
 * Character data model — mirrors apps/desktop/src-tauri/src/characters/types.rs
 */

export interface CharacterSprite {
  emotion: string; // "default", "happy", "sad", "angry", etc.
  file: string;    // path relative to game/figure/
  prompt?: string; // custom generation prompt for this sprite
}

export interface CharacterRelation {
  targetId: string;
  relationType: string; // "哥哥", "朋友", "敌人", etc.
  description: string;
}

export interface Character {
  id: string;
  name: string;            // primary name used in script dialogue
  aliases: string[];       // nicknames / alternative names
  description: string;     // visual appearance description for sprite generation
  personality: string;     // personality traits
  referenceImages?: string[]; // filenames in game/reference/<characterId>/
  stance: string;          // moral/faction stance: "正义", "混沌", "中立", "邪恶"
  keywords: string[];      // searchable tags: ["学生", "傲娇", "学生会"]
  dialogueStyle: string;   // character voice / speech style guide for AI
  gender: string;          // "男", "女", "其他"
  age: string;             // age group or specific age
  sprites: CharacterSprite[];
  defaultVoice?: string;   // default voice file path
  voiceTimbre?: string;    // TTS voice type (for future)
  relations: CharacterRelation[];
  colorTheme?: string;     // accent color
  notes: string;           // free-form notes
}

export interface CharacterRef {
  id: string;
  name: string;
}
