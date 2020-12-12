from copy import deepcopy
from datetime import datetime
from fortnitepy.ext import commands # not a default lib
from threading import Thread
from time import perf_counter, sleep, time, mktime, ctime
from tkinter import *
from tkinter import filedialog, messagebox, scrolledtext
from tkinter.ttk import Progressbar
from watchdog.events import PatternMatchingEventHandler # not a default lib
from watchdog.observers import Observer # not a default lib
import fortnitepy # not a default lib
import json
import os
import pyperclip # not a default lib
import requests
import subprocess
import sys
import webbrowser
import asyncio

# test function for memes
def testing():
	pass

# File watching
loadWatcher = False
def replayCreated(event):
	global loadWatcher, progress, gameHistory
	fileName = event.src_path.split('/')[-1]
	if ".replay" in fileName:
		if not loadWatcher:
			progress.configure(mode="indeterminate")
			Thread(target=loading, daemon=True).start()
			loadWatcher = True
		gameHistory.configure(state=NORMAL)
		current = gameHistory.get(1.0, END).split("\n")
		current.pop()
		print(current[-1])
		while len(current) > 0 and "name" in current[-1].lower():
			current.pop()
		gameHistory.delete(1.0, END)
		gameHistory.insert(INSERT, "\n".join(current))
		gameHistory.see(END)
		gameHistory.configure(state=DISABLED)
		insertText(text=f"Watching new game: {fileName}")

def replayModified(event):
	fileName = event.src_path.split('/')[-1]
	if ".replay" in fileName:
		consoleThreader(event.src_path)

def playerModified(event):
	global database, progress, loadWatcher
	if event.src_path == ".\\playerList.json":
		if loadWatcher:
			progress.configure(mode="determinate")
			loadWatcher = False
		# theres spooky replay writes happening repeatedly at the end of games, this is the lazy protection, wait and try again
		try:
			playerBase = loadFile("playerList.json")
		except:
			sleep(0.3)
			playerBase = loadFile("playerList.json")
		if playerBase["session"] not in database["sessions"].keys():
			inc = 0
			for players in playerBase["players"]:
				target = playerExists(players[2])
				if target == -1:
					database["sessions"][playerBase["session"]] = playerBase["time"]
					database["players"].append({"id":players[2], "name":None, "platform":players[3], "games":[playerBase["session"]]})
				else:
					database["players"][target]["games"].append(playerBase["session"])
				inc += 1
				bar(inc / playerBase["totalPlayers"] * 100)
			database["replays"].append(playerBase["file"])
			if time() - os.path.getmtime("database.json") > 5: # no way someone will do 2 games within 5 seconds, right? gotta stop duplicate writing somehow
				writeFile("database.json", database)
				writeFile("database.backup", database) # hopefully a good chance to save a backup and nothing breaks
				displayLast()
			insertText(f"{playerBase['file']} - {len(playerBase['players']) + 1}/{playerBase['totalPlayers']} Real Players", clearing=True)
			bar(0)
			nameThreader()

# binding the file readers
if __name__ == "__main__":
	ignore_patterns = ""
	ignore_directories = False
	case_sensitive = True
	replayFileHandler = PatternMatchingEventHandler("*.replay", ignore_patterns, ignore_directories, case_sensitive)
	replayFileHandler.on_created = replayCreated
	replayFileHandler.on_modified = replayModified
	playerFileHandler = PatternMatchingEventHandler("*/playerList.json", ignore_patterns, ignore_directories, case_sensitive)
	playerFileHandler.on_modified = playerModified
	path = os.getenv('LOCALAPPDATA') + "/FortniteGame/Saved/Demos/"
	replayObserver = Observer()
	replayObserver.schedule(replayFileHandler, path, recursive=False)
	playerObserver = Observer()
	playerObserver.schedule(playerFileHandler, ".", recursive=False)

# Epic Connection, this whole bit basically just watches a file to see if new epic ids are added, and then finds the match names based on that
checkNames = False
class MyClient(fortnitepy.Client):
	def __init__(self):
		device_auth_details = self.get_device_auth_details().get(email, {})
		super().__init__(
			auth=fortnitepy.AdvancedAuth(
				email=email,
				password=password,
				prompt_authorization_code=True,
				delete_existing_device_auths=True,
				**device_auth_details
			)
		)

	def get_device_auth_details(self):
		if os.path.isfile(filename):
			with open(filename, 'r') as fp:
				return json.load(fp)
		return {}

	def store_device_auth_details(self, email, details):
		existing = self.get_device_auth_details()
		existing[email] = details
		with open(filename, 'w') as fp:
			json.dump(existing, fp)

	async def event_device_auth_generate(self, details, email):
		self.store_device_auth_details(email, details)

	async def event_ready(self):
		global database, checkNames
		unknowns = 0
		tracked = 0
		def incPlayers():
			if unknowns != 0:
				bar(tracked / unknowns * 100)
		def customClear(text):
			global gameHistory
			gameHistory.configure(state=NORMAL)
			current = gameHistory.get(1.0, END).split("\n")
			current.pop()
			x = 0
			while x < len(current):
				if "watching" in current[x].lower() or "name" in current[x].lower():
					current.pop(x)
					x -= 1
				else: x += 1
			current.append(text)
			gameHistory.delete(1.0, END)
			gameHistory.insert(INSERT, "\n".join(current))
			gameHistory.see(END)
			gameHistory.configure(state=DISABLED)
		def namesValidator():
			validated = True
			for player in database["players"]:
				if not player["name"]:
					validated = False
					break
			if validated:
				customClear("Names have been updated.")
				if currentView == "last": displayLast()
				if saveFeed.get():
					feedSaver()
			else: insertText("Name retrieval failed, check connection and try again.", clearing=True)
		insertText("Connected to Epic as {}".format(self.user.display_name), clearing=True)
		while checkNames != None: # better event implementations COULD be made, oh well, works cleanly as is
			if checkNames:
				insertText("Updating names...")
				for player in database["players"]:
					if player["name"] == None:
						unknowns += 1
				for x in range(len(database["players"])):
					if database["players"][x]["name"] == None:
						user = await self.fetch_profile(database["players"][x]["id"])
						database["players"][x]["name"] = user.display_name
						tracked += 1
						incPlayers()
				bar(0)
				unknowns = 0
				tracked = 0
				checkNames = False
				writeFile("database.json", database)
				try: namesValidator() # this seems to be the only crashpoint, so blocking it off just in case
				except: pass
			else:
				sleep(1)
		insertText("Connection to Epic crashed, please restart the program.") # simple way to tell if the while loop crashed

# Operation functionss
# setup/reset for database and config file
def initDatabase():
	global database, config, saveFeed
	original = deepcopy(database)
	current = database.keys()
	if "replays" not in current: database["replays"] = []
	if "sessions" not in current: database["sessions"] = {}
	if "players" not in current: database["players"] = []
	if database != original: writeFile("database.json", database)
	original = deepcopy(config)
	current = config.keys()
	if "email" not in current: config["email"] = "YourEpicEmail@email.com"
	if "snipeCounts" not in current: config["snipeCounts"] = 2
	if "settings" not in current: config["settings"] = {"xPos" : 0, "yPos" : 0, "saveFeed":saveFeed.get()}
	if "friends" not in current: config["friends"] = []
	if config != original: writeFile("config.json", config)

def loadFile(target):
	with open(target, encoding="utf-8") as f:
		data = json.load(f)
	f.close()
	return data

def writeFile(target, data):
	try:
		with open(target, 'w', encoding="utf-8") as f:
			json.dump(data, f)
		f.close()
		return 0
	except:
		return -1

# since we're working in 32-bit python, large replay data will eventually cause crashes
# also it slows down overall performance so might as well cap it
# should I fix this? ye, probably, but my current solution is just to shift out your data to another file, dont play a 1000 matches per week, its unhealthy
def databaseOverload():
	global database
	if os.path.getsize("database.json") >= 50 * 1000000: # 50 mb currently
		nextName = "database0.json"
		n = 0
		while os.path.exists(nextName):
			n += 1
			nextName = "database" + str(n) + ".json"
		os.rename("database.json", nextName)
		database = {}
		initDatabase()
		insertText("Your game data was getting too large and was reset.")
		insertText(f"Old game data moved over to {nextName}.")
	return

# close event handler, cleanup the file observers
def closeProgram():
	global config, saveFeed, hideFriends
	original = deepcopy(config)
	config["settings"]["xPos"] = root.winfo_x()
	config["settings"]["yPos"] = root.winfo_y()
	config["settings"]["saveFeed"] = saveFeed.get()
	config["settings"]["hideFriends"] = hideFriends.get()
	if config != original: writeFile("config.json", config)
	root.destroy()
	replayObserver.stop()
	replayObserver.join()
	playerObserver.stop()
	playerObserver.join()
	sys.exit()

def canScroll(event):
	canvas.configure(scrollregion=canvas.bbox("all"), bg="black")

# method for placing text in the match history box
def insertText(text, clearing=False):
	global gameHistory
	gameHistory.configure(state=NORMAL)
	current = gameHistory.get(1.0, END).split("\n")
	current.pop()
	if text:
		if clearing: current[-1] = text
		else: current.append(text)
	else: current.pop()
	gameHistory.delete(1.0, END)
	gameHistory.insert(INSERT, "\n".join(current))
	gameHistory.see(END)
	gameHistory.configure(state=DISABLED)

# animation to let the user know that something is happening
def loading():
	global progress, loadWatcher
	sleep(0.05)
	progress.configure(mode="indeterminate")
	while loadWatcher:
		if progress["value"] < 100:
			bar(progress["value"] + 1)
		else:
			bar(0)
		sleep(0.005)
	bar(0)

def bar(value):
	progress["value"] = float(value)

# opens fortnite profile for selected user
def nameHandler(event):
	name = event.widget.get()
	if name and name != "bot" and name != "YOU" and name != "null":
		url = "https://fortnitetracker.com/profile/all/" + name
		webbrowser.open(url, new=2)

# copy paste to clipboard functions
targetWidget = None
def copyEntry(event):
	global targetWidget
	pyperclip.copy(event.widget.get())
	targetWidget = event.widget
	Thread(target=swapColour).start()

def swapColour():
	global targetWidget
	targetWidget.configure(bg="white")
	sleep(0.05)
	targetWidget.configure(bg="black")

# multi-threading the replay reader within, fun and clean implementation
def consoleThreader(filePath):
	Thread(target=conReader, args=[filePath], daemon=True).start()

def conReader(filePath):
	CREATE_NO_WINDOW = 0x08000000
	subprocess.call("ReplayParser.exe " + filePath, shell=False, creationflags=CREATE_NO_WINDOW)

def nameThreader():
	global checkNames
	checkNames = True

# adds a replay file to the database if necessary
def addReplay():
	global database, loadWatcher, progress
	path = os.getenv('LOCALAPPDATA') + "/FortniteGame/Saved/Demos/"
	replayName = filedialog.askopenfilename(initialdir = path,title = "Select replay", filetypes = (("replay files","*.replay"),("all files","*.*")))
	if replayName.split("/")[-1] in database["replays"]: insertText(f"{replayName.split('/')[-1]} was already added, reloading data.")
	if ".replay" in replayName.split("/")[-1]:
		if not loadWatcher:
			progress.configure(mode="indeterminate")
			Thread(target=loading, daemon=True).start()
			loadWatcher = True
		consoleThreader(replayName)

# clears out everything if you wanna start fresh from all the stream snipers
def resetDatabase():
	POP_WIDTH = 250
	POP_HEIGHT = 50
	popup = Toplevel()
	popup.wm_title("Database Reset")
	popup.configure(bg="black")
	popup.iconbitmap("icon.ico")
	popup.resizable(False, False)
	w = root.winfo_width()
	h = root.winfo_height()
	x = root.winfo_x()
	y = root.winfo_y()
	xPos = x + (w / 2) - (POP_WIDTH / 2)
	yPos = y + (h / 2) - (POP_HEIGHT / 2)
	popup.geometry(f"+{int(xPos)}+{int(yPos)}")
	popup.geometry(f"{POP_WIDTH}x{POP_HEIGHT}")
	Label(popup, text="Confirm database reset?", bg="black", fg="white").pack(side=TOP)
	Button(popup, text="YES", command=lambda:resetConfirm(popup), bg="black", fg="white", width=10).pack(expand=TRUE, side=LEFT)
	Button(popup, text="NO", command=lambda:popup.destroy(), bg="black", fg="white", width=10).pack(expand=TRUE, side=LEFT)
	popup.grab_set()
	popup.mainloop()

def resetConfirm(popup):
	global database
	popup.grab_release()
	popup.destroy()
	database = {}
	initDatabase()

def rollCredits(): # credits widget
	POP_WIDTH = 400
	POP_HEIGHT = 168
	popup = Toplevel()
	popup.wm_title("About")
	popup.configure(bg="black")
	popup.iconbitmap("icon.ico")
	popup.resizable(False, False)
	w = root.winfo_width()
	h = root.winfo_height()
	x = root.winfo_x()
	y = root.winfo_y()
	xPos = x + (w / 2) - (POP_WIDTH / 2)
	yPos = y + (h / 2) - (POP_HEIGHT / 2)
	popup.geometry(f"+{int(xPos)}+{int(yPos)}")
	popup.geometry(f"{POP_WIDTH}x{POP_HEIGHT}")
	creditors = Label(popup, text="""
	If you appreciate my work, you can donate at
	https://streamlabs.com/guardianseeker/tip

	Contact me on discord for help Gun-Grave#8284.
	Thanks to Shiqan for the FortniteReplayDecompressor API.
	Thanks to Terbau for the fortnitepy API.
	""", bg="black", fg="white")
	creditors.bind("<Button-1>", lambda e: webbrowser.open_new("https://streamlabs.com/guardianseeker/tip"))
	creditors.pack(expand=TRUE, padx=(0, 50))
	popup.grab_set()
	popup.mainloop()

def lookupPlayer(): # popup widget that asks who you're trying to search for
	def findName(target):
		popup.grab_release()
		popup.destroy()
		if (target == ""): return
		for player in database["players"]:
			if player["name"] == target:
				displayPlayer(player)
				return
	def findID(target):
		popup.grab_release()
		popup.destroy()
		if (target == ""): return
		for player in database["players"]:
			if player["id"] == target:
				displayPlayer(player)
				return
	global database
	POP_WIDTH = 250
	POP_HEIGHT = 55
	popup = Toplevel()
	popup.wm_title("Lookup System")
	popup.configure(bg="black")
	popup.iconbitmap("icon.ico")
	popup.resizable(False, False)
	w = root.winfo_width()
	h = root.winfo_height()
	x = root.winfo_x()
	y = root.winfo_y()
	xPos = x + (w / 2) - (POP_WIDTH / 2)
	yPos = y + (h / 2) - (POP_HEIGHT / 2)
	popup.geometry(f"+{int(xPos)}+{int(yPos)}")
	popup.geometry(f"{POP_WIDTH}x{POP_HEIGHT}")
	name = Label(popup, text="Username: ", bg="black", fg="white")
	name.grid(row = 0, column = 0, padx=(10, 5))
	nameField = Entry(popup, text="", bg="black", fg="white")
	nameField.grid(row = 0, column = 1, padx=(0, 10))
	nameSend = Button(popup, text="GO", command=lambda:findName(nameField.get()), bg="black", fg="white")
	nameSend.grid(row = 0, column = 2)
	uid = Label(popup, text="ID: ", bg="black", fg="white")
	uid.grid(row = 1, column = 0, padx=(10, 5))
	uidField = Entry(popup, text="", bg="black", fg="white")
	uidField.grid(row = 1, column = 1, padx=(0, 10))
	uidSend = Button(popup, text="GO", command=lambda:findID(uidField.get()), bg="black", fg="white")
	uidSend.grid(row = 1, column = 2)
	popup.grab_set()
	popup.mainloop()

def friendsList(): # friends widget that manages who to hide or ignore as a stream sniper
	def addFriend(target):
		newFriend.delete(0, END)
		if target in ["", "bot", "YOU"]:
			return
		if target not in config["friends"]:
			config["friends"].append(target)
			writeFile("config.json", config)
			updateFriends()
	def removeFriend(target):
		newFriend.delete(0, END)
		if target == "":
			return
		for x in range(len(config["friends"])):
			if config["friends"][x] == target:
				config["friends"].pop(x)
				writeFile("config.json", config)
				updateFriends()
				break
	def resetFriends():
		config["friends"] = []
		writeFile("config.json", config)
		updateFriends()
	def updateFriends():
		lines = ""
		for player in config["friends"]:
			lines += player + "\n"
		friends.configure(state=NORMAL)
		friends.delete(1.0, END)
		friends.insert(INSERT, lines)
		friends.see(END)
		friends.configure(state=DISABLED)
	def toggleCheck(e):
		hideCheck.invoke()
	global config, hideFriends
	POP_WIDTH = 300
	POP_HEIGHT = 436
	popup = Toplevel()
	popup.wm_title("Friends List")
	popup.configure(bg="black")
	popup.iconbitmap("icon.ico")
	popup.resizable(False, False)
	w = root.winfo_width()
	h = root.winfo_height()
	x = root.winfo_x()
	y = root.winfo_y()
	xPos = x + (w / 2) - (POP_WIDTH / 2)
	yPos = y + (h / 2) - (POP_HEIGHT / 2)
	popup.geometry(f"+{int(xPos)}+{int(yPos)}")
	popup.geometry(f"{POP_WIDTH}x{POP_HEIGHT}")
	# main area setup
	headers = Frame(popup, bg="black")
	headers.pack(pady=(4,2))
	Label(headers, text = "Friends List", font = ("Times New Roman", 14), bg="black", fg="white").pack(side=LEFT, padx=(0, 8))
	Button(headers, text="RESET", command=resetFriends, bg="black", fg="white").pack(side=LEFT)
	if "friends" not in config.keys():
		config["friends"] = []
	friends = scrolledtext.ScrolledText(popup, wrap=WORD, height=18, font=("Times New Roman", 12), bg="black", fg="white")
	updateFriends()
	friends.pack()
	# friends actions
	friendActions = Frame(popup, bg="black")
	friendActions.pack(pady=(4,0))
	Label(friendActions, text="Username/ID", bg="black", fg="white").pack(side=LEFT)
	newFriend = Entry(friendActions, text="", bg="black", fg="white")
	newFriend.pack(side=LEFT, padx=(0, 4))
	Button(friendActions, text="ADD", command=lambda:addFriend(newFriend.get()), bg="black", fg="white").pack(side=LEFT)
	Button(friendActions, text="REMOVE", command=lambda:removeFriend(newFriend.get()), bg="black", fg="white").pack(side=LEFT)
	# hide friends
	hiderFrame = Frame(popup, bg="black")
	hiderFrame.pack()
	hideCheck = Checkbutton(hiderFrame, variable=hideFriends, onvalue = 1, offvalue = 0, bg="black")
	hideCheck.pack(side=LEFT)
	hideLabel = Label(hiderFrame, text="Hide friends from Kill Feed", bg="black", fg="white")
	hideLabel.bind("<Button-1>", toggleCheck)
	hideLabel.pack(side=LEFT)
	popup.grab_set()
	popup.mainloop()

# handles right click events on the table values
def rClicker(e, profile=False, noFilter=False, lookup=False, idtag=False):
	global matrix, database
	try:
		def rClickCopy(e):
			pyperclip.copy(e.widget.get())
		def rClickFilter(e, mode):
			def destroyRow(r):
				if r != 0:
					for widget in matrix.grid_slaves(row=r):
						widget.destroy()
			r = e.widget.grid_info()["row"]
			c = e.widget.grid_info()["column"]
			target = e.widget.get()
			for widget in matrix.winfo_children():
				try:
					if mode == "in" and c == widget.grid_info()["column"] and target != widget.get():
						destroyRow(widget.grid_info()["row"])
					elif mode == "out" and c == widget.grid_info()["column"] and target == widget.get():
						destroyRow(widget.grid_info()["row"])
				except TclError: # dirty bypass for a deleted row and skipping consecutive non-existent elements
					pass
			canvas.yview_moveto(0.0)
		def profilePaster(e):
			if e.widget.get() not in ["bot", "YOU", ""]:
				pyperclip.copy("https://fortnitetracker.com/profile/all/" + e.widget.get())
		def friendAction(e, action):
			if action == "add":
				config["friends"].append(e.widget.get())
			else:
				config["friends"].pop(config["friends"].index(e.widget.get()))
		def lookupProfile(e):
			def findName(target):
				if (target == ""): return
				for player in database["players"]:
					if player["name"] == target:
						return player
			def findID(target):
				if (target == ""): return
				for player in database["players"]:
					if player["id"] == target:
						return player
			target = e.widget.get()
			named = findName(target)
			if named:
				displayPlayer(named)
				return
			ideed = findID(target)
			if ideed:
				displayPlayer(ideed)
				return

		if not noFilter:
			clickList = [
				("Copy", lambda: rClickCopy(e)),
				("Filter By", lambda: rClickFilter(e, "in")),
				("Filter Out", lambda: rClickFilter(e, "out"))
			]
		else: clickList = [("Copy", lambda: rClickCopy(e))]
		if profile:
			if len(e.widget.get()) != 32:
				clickList.append(("Profile Link", lambda: profilePaster(e)))
			if e.widget.get() in config["friends"]:
				clickList.append(("Remove Friend", lambda: friendAction(e, "remove")))
			elif e.widget.get() != "bot" and e.widget.get() != "null" and e.widget.get() != "YOU":
				clickList.append(("Add Friend", lambda: friendAction(e, "add")))
		if lookup:
			clickList.append(("Lookup Player", lambda: lookupProfile(e)))
		rmenu = Menu(None, tearoff=0, takefocus=0)
		for (txt, cmd) in clickList:
			rmenu.add_command(label=txt, command=cmd)
		rmenu.tk_popup(e.x_root+26, e.y_root+11, entry="0") # aligning the menu to land on mouse
	except TclError:
		pass

# Sniper functions
def getPlayer(id):
	global database
	for player in database["players"]:
		if player["id"] == id:
			return player

def playerExists(id):
	global database
	for x in range(len(database["players"])):
		if id == database["players"][x]["id"]:
			return x
	return -1

# suggestion from twitch.tv/Moonit to basically output the killfeed to a excel sheet so that you can view/share it with others (moderators so they can also find out who's sniping from the list of names)
def feedSaver():
	def teamNumber(id):
		if (id == playerBase["owner"]):
			return playerBase["team"]
		for player in playerBase["players"]:
			if player[2] == id:
				return player[0]
	try:
		os.chdir("..")
		dayMade = datetime.utcfromtimestamp(os.path.getctime("Kill Feed.csv")).strftime("%d")
		if dayMade != datetime.now().strftime("%d"):
			f = open("Kill Feed.csv", "w", encoding="utf-8")
			f.close()
	except:
		f = open("Kill Feed.csv", "w", encoding="utf-8")
		f.close()
	f = open("Kill Feed.csv", "a", encoding="utf-8")
	os.chdir("CODE")
	playerBase = loadFile("playerList.json")
	lines = f"{playerBase['file']},{playerBase['session']},{playerBase['time']}\n"
	lines += "Time,Team #,Killer,Action,Team #,Killed,Weapon,Killer ID,Killed ID\n"
	for i in range(len(playerBase["killfeed"])): # rows
		for j in range(9): # columns
			killer = getPlayer(playerBase["killfeed"][i][0])
			killed = getPlayer(playerBase["killfeed"][i][1])
			if playerBase["killfeed"][i][0] == playerBase["owner"]: killer = {"id": playerBase["owner"], "name":"YOU", "platform":"YOU"}
			elif killer == None: killer = {"id":"bot", "name":"bot", "platform":"bot"}
			if playerBase["killfeed"][i][1] == playerBase["owner"]: killed = {"id": playerBase["owner"], "name":"YOU", "platform":"YOU"}
			elif killed == None: killed = {"id":"bot", "name":"bot", "platform":"bot"}
			if j == 0:
				temp = playerBase["killfeed"][i][4] + ","
			elif j == 1:
				if killer["id"] == "bot": temp = str(-1) + ","
				else: temp = str(teamNumber(killer["id"])) + ","
			elif j == 2:
				temp = killer["name"] + ","
				if not temp: temp = "null" + ","
			elif j == 3:
				temp = "killed" + ","
				if playerBase["killfeed"][i][3]:
					temp = "knocked" + ","
			elif j == 4:
				if killed["id"] == "bot": temp = str(-1) + ","
				else: temp = str(teamNumber(killed["id"])) + ","
			elif j == 5:
				temp = killed["name"] + ","
				if not temp: temp = "null" + ","
			elif j == 6:
				temp = playerBase["killfeed"][i][2] + ","
			elif j == 7:
				temp = killer["id"] + ","
			else:
				temp = killed["id"]
			lines += temp
		lines += "\n"
	f.write(lines)
	f.close()

# display information about a singular player in the database
def displayPlayer(player):
	global PLAY_WIDTH, database, canvas, matrix, currentView
	currentView = "player"
	canvas.yview_moveto(0.0)
	canvas.configure(width=PLAY_WIDTH)
	for widget in matrix.winfo_children():
		widget.destroy()
	headers = Frame(matrix, bg="black")
	b = Entry(headers, text="", bg="black", fg="white", cursor="arrow", width=4) # Platform
	b.insert(0, player["platform"])
	b.bind("<Key>", lambda e: "break")
	b.bind("<Button-1>", copyEntry)
	b.bind("<Button-3>", lambda e: rClicker(e, noFilter=True))
	b.pack(side=LEFT)
	if player["name"]: temp = player["name"]
	else: temp = "null"
	b = Entry(headers, text="", bg="black", fg="white", cursor="arrow", width=47) # Name
	b.insert(0, temp)
	b.bind("<Key>", lambda e: "break")
	b.bind("<Double-Button-1>", nameHandler)
	b.bind("<Button-3>", lambda e: rClicker(e, profile=True, noFilter=True))
	b.bind("<Button-1>", copyEntry)
	b.pack(side=LEFT)
	b = Entry(headers, text="", bg="black", fg="white", cursor="arrow", width=32) # ID
	b.insert(0, player["id"])
	b.bind("<Key>", lambda e: "break")
	b.bind("<Button-1>", copyEntry)
	b.bind("<Button-3>", lambda e: rClicker(e, profile=True, noFilter=True))
	b.pack(side=LEFT)
	headers.pack(fill=X)
	for x in range(len(player["games"])): # Games
		temp = list(database['sessions'].keys())
		temp = temp.index(player['games'][x])
		temp = f"Replay: {database['replays'][temp]} - Game ID: {player['games'][x]}"
		b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow", width=83)
		b.insert(0, temp)
		b.bind("<Key>", lambda e: "break")
		b.bind("<Button-1>", copyEntry)
		b.bind("<Button-3>", lambda e: rClicker(e, noFilter=True))
		b.pack(fill=X)

# display details of the last replay that was read
def displayLast():
	global LAST_WIDTH, canvas, currentView, config
	currentView = "last"
	canvas.yview_moveto(0.0)
	for widget in matrix.winfo_children():
		widget.destroy()
	playerBase = loadFile("playerList.json")
	annoyances = []
	for player in playerBase["players"]:
		temp = getPlayer(player[2])
		if temp and temp["id"] not in config["friends"] and temp["name"] not in config["friends"] and len(temp["games"]) >= config["snipeCounts"]:
			annoyances.append([temp, len(temp["games"]), player[0]]) # store player, snipe count, and their team number
	canvas.configure(width=LAST_WIDTH)
	for x in range(6): # Set headers
		b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
		if x == 0:
			temp = "EPIC ID"
			b.configure(width=20)
		elif x == 1:
			temp = "Platform"
			b.configure(width=9)
		elif x == 2:
			temp = "Username"
			b.configure(width=12)
		elif x == 3:
			temp = "Team #"
			b.configure(width=7)
		elif x == 4:
			temp = "Snipe Count"
			b.configure(width=11)
		else:
			temp = "Last Seen"
			b.configure(width=22)
		b.insert(0, temp)
		b.bind("<Key>", lambda e: "break")
		b.grid(row=0, column=x)
	if len(annoyances) > 0:
		annoyances.sort(key=lambda x: x[1])
		annoyances.reverse()
		for i in range(len(annoyances)): # rows
			player = annoyances[i][0]
			for j in range(6): # columns
				b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
				if j == 0:
					temp = player["id"]
					b.configure(width=20)
				elif j == 1:
					temp = player["platform"]
					b.configure(width=9)
				elif j == 2:
					temp = player["name"]
					if not temp: temp = "null"
					b.configure(width=12)
				elif j == 3:
					temp = annoyances[i][2]
					b.configure(width=7)
				elif j == 4:
					temp = len(player["games"])
					b.configure(width=11)
				else:
					if len(player["games"]) > 1: temp = database["sessions"][player["games"][-2]]
					else: temp = database["sessions"][player["games"][0]]
					b.configure(width=22)
				b.insert(0, temp)
				b.bind("<Button-1>", copyEntry)
				if j == 2:
					b.bind("<Double-Button-1>", nameHandler)
					b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
				elif j == 0: b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
				else: b.bind("<Button-3>", rClicker)
				b.bind("<Key>", lambda e: "break")
				b.grid(row=i + 1, column=j)

# display the kill feed for the last replay that was read
def displayFeed():
	global FEED_WIDTH, canvas, currentView, config, hideFriends
	currentView = "feed"
	canvas.yview_moveto(0.0)
	def teamNumber(id): # retrieve team # based on id from playerList.json
		if (id == playerBase["owner"]):
			return playerBase["team"]
		for player in playerBase["players"]:
			if player[2] == id:
				return player[0]
	for widget in matrix.winfo_children():
		widget.destroy()
	playerBase = loadFile("playerList.json")
	canvas.configure(width=FEED_WIDTH)
	for x in range(9): # Set headers
		b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
		if x == 0:
			temp = "Time"
			b.configure(width=6)
		elif x == 1:
			temp = "Team #"
			b.configure(width=7)
		elif x == 2:
			temp = "Killer"
			b.configure(width=12)
		elif x == 3:
			temp = "Action"
			b.configure(width=7)
		elif x == 4:
			temp = "Team #"
			b.configure(width=7)
		elif x == 5:
			temp = "Killed"
			b.configure(width=12)
		elif x == 6:
			temp = "Weapon"
			b.configure(width=10)
		elif x == 7:
			temp = "Killer ID"
			b.configure(width=20)
		else:
			temp = "Killed ID"
			b.configure(width=20)
		b.insert(0, temp)
		b.bind("<Key>", lambda e: "break")
		b.grid(row=0, column=x)
	for i in range(len(playerBase["killfeed"])): # rows
		for j in range(9): # columns
			# check if the player exists in the database, if they do, good, if not, they're a bot or haven't had their name pulled yet
			killer = getPlayer(playerBase["killfeed"][i][0])
			killed = getPlayer(playerBase["killfeed"][i][1])
			if playerBase["killfeed"][i][0] == playerBase["owner"]: killer = {"id": playerBase["owner"], "name":"YOU", "platform":"YOU"}
			elif killer == None:
				if playerBase["killfeed"][i][0] == "NPC": killer = {"id":"bot", "name":"NPC", "platform":"bot"}
				else: killer = {"id":"bot", "name":"bot", "platform":"bot"}
			if playerBase["killfeed"][i][1] == playerBase["owner"]: killed = {"id": playerBase["owner"], "name":"YOU", "platform":"YOU"}
			elif killed == None:
				if playerBase["killfeed"][i][1] == "NPC": killed = {"id":"bot", "name":"NPC", "platform":"bot"}
				else: killed = {"id":"bot", "name":"bot", "platform":"bot"}
			if hideFriends.get() and (killer["id"] in config["friends"] or killer["name"] in config["friends"]):
				break
			b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
			if j == 0:
				temp = playerBase["killfeed"][i][4]
				b.configure(width=6)
			elif j == 1:
				if killer["id"] == "bot": temp = -1
				else: temp = teamNumber(killer["id"])
				b.configure(width=7)
			elif j == 2:
				temp = killer["name"]
				if not temp: temp = "null"
				b.configure(width=12)
			elif j == 3:
				temp = "killed"
				if playerBase["killfeed"][i][3]:
					temp = "knocked"
				b.configure(width=7)
			elif j == 4:
				if killed["id"] == "bot": temp = -1
				else: temp = teamNumber(killed["id"])
				b.configure(width=7)
			elif j == 5:
				temp = killed["name"]
				if not temp: temp = "null"
				b.configure(width=12)
			elif j == 6:
				temp = playerBase["killfeed"][i][2]
				b.configure(width=10)
			elif j == 7:
				temp = killer["id"]
				b.configure(width=20)
			else:
				temp = killed["id"]
				b.configure(width=20)
			b.insert(0, temp)
			b.bind("<Button-1>", copyEntry)
			if j == 2 or j == 5:
				b.bind("<Double-Button-1>", nameHandler)
				b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
			elif j >= 7: b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
			else: b.bind("<Button-3>", rClicker)
			b.bind("<Key>", lambda e: "break")
			b.grid(row=i + 1, column=j)

# display a ranked list of your stream snipers and rank them in descending order of games they've played with you
def displaySnipers():
	global SNIP_WIDTH, canvas, database, config, currentView
	currentView = "snipers"
	canvas.yview_moveto(0.0)
	for widget in matrix.winfo_children():
		widget.destroy()
	canvas.configure(width=SNIP_WIDTH)
	annoyances = []
	for player in database["players"]:
		if len(player["games"]) >= config["snipeCounts"] and player["id"] not in config["friends"] and player["name"] not in config["friends"]:
			annoyances.append([player, len(player["games"])])
	for x in range(5): # Set headers
		b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
		if x == 0:
			temp = "Snipe Count"
			b.configure(width=11)
		elif x == 1:
			temp = "EPIC ID"
			b.configure(width=21)
		elif x == 2:
			temp = "Platform"
			b.configure(width=9)
		elif x == 3:
			temp = "Username"
			b.configure(width=19)
		else:
			temp = "Last Seen"
			b.configure(width=22)
		b.insert(0, temp)
		b.bind("<Key>", lambda e: "break")
		b.grid(row=0, column=x)
	if len(annoyances) > 0:
		annoyances.sort(key=lambda x: x[1])
		annoyances.reverse()
		for i in range(len(annoyances)): # rows
			for j in range(5): # columns
				b = Entry(matrix, text="", bg="black", fg="white", cursor="arrow")
				if j == 0:
					temp = annoyances[i][1]
					b.configure(width=11)
				elif j == 1:
					temp = annoyances[i][0]["id"]
					b.configure(width=21)
				elif j == 2:
					temp = annoyances[i][0]["platform"]
					b.configure(width=9)
				elif j == 3:
					temp = annoyances[i][0]["name"]
					if not temp: temp = "null"
					b.configure(width=19)
				else:
					temp = annoyances[i][0]["games"][-1]
					temp = database["sessions"][temp]
					b.configure(width=22)
				b.insert(0, temp)
				b.bind("<Button-1>", copyEntry)
				if j == 3:
					b.bind("<Double-Button-1>", nameHandler)
					b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
				elif j == 1: b.bind("<Button-3>", lambda e: rClicker(e, profile=True, lookup=True))
				else: b.bind("<Button-3>", rClicker)
				b.bind("<Key>", lambda e: "break")
				b.grid(row=i + 1, column=j)

# Initial variable setup
try:
	with open("database.json", encoding="utf-8") as f: database = json.load(f)
	f.close()
except:
	if (os.path.exists("database.json")):
		curTime = str(datetime.now())
		curTime = curTime.replace(":", ".")
		os.rename("database.json", "databasebackup-{}.json".format(curTime))
	with open("database.json", 'w', encoding="utf-8") as f:
		f.write("{}")
	f.close()
	with open("database.json", encoding="utf-8") as f: database = json.load(f)
	f.close()
try:
	with open("config.json", encoding="utf-8") as f: config = json.load(f)
	f.close()
except:
	resetConfig = '{ "email": "YourEpicEmail@email.com","snipeCounts": 2,"settings": {"xPos": 0,"yPos": 0,"saveFeed": false} }'
	with open("config.json", 'w', encoding="utf-8") as f:
		f.write(resetConfig)
	f.close()
	with open("config.json", encoding="utf-8") as f: config = json.load(f)
	f.close()

# Initial variables setup
email = config["email"]
password = "notrequired"
filename = "device_auths.json"
version = "1.9"
fileDelay = perf_counter()
currentView = None
expandableCanvas = 269
LAST_WIDTH = 510
FEED_WIDTH = 642
PLAY_WIDTH = 510
SNIP_WIDTH = 510

# Initial UI setup
root = Tk()
root.title("Sniper Hunter by Guardian Seeker")
root.iconbitmap("icon.ico")
root.configure(bg="black")
root.geometry(f"+{config['settings']['xPos']}+{config['settings']['yPos']}")
root.resizable(False, True)
root.minsize(530, expandableCanvas * 2)

# Tracked variables
saveFeed = BooleanVar()
hideFriends = IntVar()
if "saveFeed" in config["settings"].keys() and config["settings"]["saveFeed"]: saveFeed.set(config["settings"]["saveFeed"])
if "hideFriends" in config["settings"].keys() and config["settings"]["hideFriends"]: hideFriends.set(config["settings"]["hideFriends"])

# Menu UI
menubar = Menu(root)
mainmenu = Menu(menubar, tearoff=0) # Main Menu
mainmenu.add_command(label="Fix Null Names", command=nameThreader)
mainmenu.add_command(label="Lookup Player", command=lookupPlayer)
mainmenu.add_command(label="Add Replay", command=addReplay)
mainmenu.add_command(label="Exit", command=closeProgram)
modemenu = Menu(menubar, tearoff=0) # Modes Menu
modemenu.add_command(label="Friends List", command=friendsList)
modemenu.add_checkbutton(label="Kill Feed Logger", onvalue=1, offvalue=0, variable=saveFeed)
helpmenu = Menu(menubar, tearoff=0) # Help Menu
helpmenu.add_command(label="Reset Data", command=resetDatabase)
helpmenu.add_command(label="Support/About", command=rollCredits)
menubar.add_cascade(label="Main", menu=mainmenu)
menubar.add_cascade(label="Extras", menu=modemenu)
menubar.add_cascade(label="Help", menu=helpmenu)

# Main UI
options = Frame(root) # holds the buttons
options.pack()
canFrame = Frame(root) # holds the frame for scrollable player history
canFrame.pack(fill=BOTH, expand=TRUE)
canvas=Canvas(canFrame, width=LAST_WIDTH, bg="black") # scroll space frame
matrix = Frame(canvas, bg="black") # holds table that will display player stats
canvasBar=Scrollbar(canFrame, orient="vertical", command=canvas.yview) # scrollbar
canvas.configure(yscrollcommand=canvasBar.set)
canvasBar.pack(side=RIGHT, fill="y")
canvas.pack(fill=BOTH, expand=TRUE)
matrix.pack(side=RIGHT)
canvas.create_window((0,0), window=matrix, anchor='nw')
matrix.bind("<Configure>", canScroll)
lastGame = Button(options, text="Last Game", command=displayLast, bg="black", fg="white")
lastGame.pack(side=LEFT)
killFeed = Button(options, text="Kill Feed", command=displayFeed, bg="black", fg="white")
killFeed.pack(side=LEFT)
sniperBoard = Button(options, text="Sniper List", command=displaySnipers, bg="black", fg="white")
sniperBoard.pack(side=LEFT)
#testButton = Button(options, text="TEST", command=lambda:testing(), bg="black", fg="white")
#testButton.pack(side=LEFT)
Label(root, text = "Match History", font = ("Times New Roman", 14), bg="black", fg="white").pack()
gameHistory = scrolledtext.ScrolledText(root, wrap=WORD, width=64, height=10, font=("Times New Roman", 12), bg="black", fg="white")

gameHistory.configure(state=DISABLED)
gameHistory.pack()
progress = Progressbar(root, orient = HORIZONTAL, length = LAST_WIDTH + 21, mode = 'determinate')
progress.pack()

# Update check process, simple url parse
try:
	url = "https://raw.githubusercontent.com/GuardianSeeker/SniperHunter/master/version"
	r = requests.get(url)
	gameHistory.configure(state=NORMAL)
	if r.text != version: gameHistory.insert(0.0, "Please update the program from the GitHub!")
	else: gameHistory.insert(0.0, "Your version is up-to-date!")
	gameHistory.configure(state=DISABLED)
except: pass

databaseOverload() # checks to make sure the database isn't too large before proceeding

def connectionFailed():
	sleep(7)
	current = gameHistory.get(1.0, END).split("\n")
	current.pop()
	if current[-1] == "Connecting to Epic servers...":
		insertText("Failed to connect to EPIC servers. Check connection.", clearing=True)
	return

def connectionThread():
	loop = asyncio.new_event_loop()
	asyncio.set_event_loop(loop)
	client = MyClient()
	client.run()

try:
	insertText("Connecting to Epic servers...")
	Thread(target=lambda:connectionThread(), daemon=True).start()
	Thread(target=lambda:connectionFailed(), daemon=True).start()
except:
	insertText("Failed to connect to EPIC servers. Check connection.", clearing=True)

# Start necessities
initDatabase()
replayObserver.start()
playerObserver.start()
root.protocol("WM_DELETE_WINDOW", closeProgram)
root.config(menu=menubar)
root.mainloop()


"""
JSON Structures

This is generated by the replay parser program
playerList {
	"owner" : "{owner id}",
	"team" : {NUMBER},
	"file" : "{replay name}",
	"session" : "{id of the game session}",
	"time" : "{starting time of that game}",
	"totalPlayers" : {# for total real players in that lobby},
	"players" : [
		[
			{team number},
			{bool if they're a teammate},
			{player id},
			{platform, pc, switch, etc.}
		],
		[
			repeating....
		]
	],
	"killfeed" : [
		[
			"{killer}",
			"{killed}",
			"{weapon}",
			"{is a knock}",
			"{time of death}",
			"{weapon killed ID, this is for diagnostic purposes}"
		],
		[
			repeating....
		]
	]
}

this is generated in here
database {
	"replays" : [
		"{name of a replay that's been read, A}",
		"{name of another replay, B}"
	],
	"sessions" : [
		"{game id of that matching replay, A}" : "{date and time of replay}",
		"{game id for B}" : "{date and time for that replay}"
	],
	"players" : [
		{
			"id" : "{player id}",
			"name" : "{epic ign for the player, if it was retrieved, otherwise null}",
			"platform" : "{pc, switch, etc.}",
			"games": [
				"{game session id A that they were with you in}",
				"{game session id B}"
			]
		},
		{
			repeating...
		}
	]
}
"""