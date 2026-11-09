#pragma once
// Original implementation; references documented in README.
inline constexpr const char* mvMzRuntime = R"JS((function(){
'use strict';
var dictionary={},cache=new Map(),busy=false;
function translate(value){
 if(typeof value!=='string'||!value)return value;
 if(cache.has(value))return cache.get(value);
 var result=Object.prototype.hasOwnProperty.call(dictionary,value)&&dictionary[value]?dictionary[value]:value;
 if(result===value&&value.indexOf('\n')>=0)result=value.split('\n').map(translate).join('\n');
 if(cache.size>=20000)cache.clear();cache.set(value,result);return result;
}
var request=new XMLHttpRequest();request.open('GET','LLMChat-translations.json');
request.onload=function(){if(request.status<400){dictionary=JSON.parse(request.responseText);cache.clear();}};
request.onerror=function(){console.error('LLMChat: cannot load translations');};request.send();
function hook(object,key,index){var original=object[key];if(!original)return;object[key]=function(){var args=Array.prototype.slice.call(arguments);if(!busy){busy=true;try{args[index]=translate(args[index]);return original.apply(this,args);}finally{busy=false;}}return original.apply(this,args);};}
hook(Bitmap.prototype,'drawText',0);hook(Bitmap.prototype,'measureTextWidth',0);
hook(Window_Base.prototype,'convertEscapeCharacters',0);
hook(Window_Command.prototype,'addCommand',0);hook(Window_BattleLog.prototype,'addText',0);
var message=Game_Message.prototype.add;Game_Message.prototype.add=function(value){return message.call(this,translate(value));};
var choices=Game_Message.prototype.setChoices;Game_Message.prototype.setChoices=function(values,cancel,def){return choices.call(this,values.map(translate),cancel,def);};
var font='__FONT__';
if(font){if(typeof FontManager!=='undefined')FontManager.load('llmchat-gamefont',font);
else if(typeof Graphics.loadFont==='function')Graphics.loadFont('llmchat-gamefont','fonts/'+font);
var face=Window_Base.prototype.standardFontFace;if(face)Window_Base.prototype.standardFontFace=function(){return 'llmchat-gamefont,'+face.call(this);};
if(typeof Game_System.prototype.mainFontFace==='function'){var main=Game_System.prototype.mainFontFace;Game_System.prototype.mainFontFace=function(){return 'llmchat-gamefont,'+main.call(this);};}}
})();
)JS";
