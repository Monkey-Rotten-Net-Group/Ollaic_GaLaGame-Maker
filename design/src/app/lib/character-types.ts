/**
 * Character data model — mirrors src-tauri/src/characters/types.rs
 */

export interface CharacterSprite {
  emotion: string; // "default", "happy", "sad", "angry", etc.
  file: string;    // filename in game/figure/
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
  description: string;     // backstory / role description
  personality: string;     // personality traits
  consistencyPrompt?: string; // stable image-generation prompt prefix
  referenceImages?: string[]; // filenames in game/config/references/
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
