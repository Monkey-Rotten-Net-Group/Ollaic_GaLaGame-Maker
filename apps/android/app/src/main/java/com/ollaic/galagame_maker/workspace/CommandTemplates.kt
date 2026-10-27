package com.ollaic.galagame_maker.workspace

import com.ollaic.galagame_maker.R
import com.ollaic.core.CommandKind

internal val commandTitles = mapOf(
  "intro" to R.string.command_intro,
  "choose" to R.string.command_choose,
  "changeBg" to R.string.command_background,
  "changeFigure" to R.string.command_figure,
  "miniAvatar" to R.string.command_avatar,
  "bgm" to R.string.command_bgm,
  "playEffect" to R.string.command_effect,
  "playVideo" to R.string.command_video,
  "changeScene" to R.string.command_change_scene,
  "callScene" to R.string.command_call_scene,
  "label" to R.string.command_label,
  "jumpLabel" to R.string.command_jump,
  "setVar" to R.string.command_variable,
  "getUserInput" to R.string.command_input,
  "setTextbox" to R.string.command_textbox,
  "setAnimation" to R.string.command_animation,
  "setTransform" to R.string.command_transform,
  "unlockCg" to R.string.command_unlock_cg,
  "unlockBgm" to R.string.command_unlock_bgm,
  "end" to R.string.command_end,
)

internal val structuredCommands = listOf(
  R.string.workspace_dialogue to CommandKind.DIALOGUE,
  R.string.workspace_narration to CommandKind.NARRATOR,
  R.string.workspace_note to CommandKind.COMMENT,
  R.string.command_intro to CommandKind.INTRO,
  R.string.command_choose to CommandKind.CHOOSE,
  R.string.command_change_scene to CommandKind.CHANGE_SCENE,
  R.string.command_call_scene to CommandKind.CALL_SCENE,
  R.string.command_label to CommandKind.LABEL,
  R.string.command_jump to CommandKind.JUMP_LABEL,
  R.string.command_variable to CommandKind.SET_VAR,
  R.string.command_input to CommandKind.GET_USER_INPUT,
  R.string.command_textbox to CommandKind.SET_TEXTBOX,
  R.string.command_transform to CommandKind.SET_TRANSFORM,
  R.string.command_end to CommandKind.END,
  R.string.command_background to CommandKind.CHANGE_BG,
  R.string.command_figure to CommandKind.CHANGE_FIGURE,
  R.string.command_avatar to CommandKind.MINI_AVATAR,
  R.string.command_bgm to CommandKind.BGM,
  R.string.command_effect to CommandKind.PLAY_EFFECT,
  R.string.command_video to CommandKind.PLAY_VIDEO,
  R.string.command_animation to CommandKind.SET_ANIMATION,
  R.string.command_unlock_cg to CommandKind.UNLOCK_CG,
  R.string.command_unlock_bgm to CommandKind.UNLOCK_BGM,
)
