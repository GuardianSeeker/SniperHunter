import fortnitepy
import json
import os
import sys
from time import sleep
from threading import Thread

with open("config.json", "r", encoding="utf-8") as f:
	config = json.load(f)
f.close()

email = config["email"]
password = config["password"]
filename = 'device_auths.json'
validLogin = False

class MyClient(fortnitepy.Client):
	def __init__(self):
		device_auth_details = self.get_device_auth_details().get(email, {})
		super().__init__(
			auth=fortnitepy.AdvancedAuth(
				email=email,
				password=password,
				prompt_exchange_code=True,
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
		print(f"Logged in as {self.user.display_name}")
		if len(sys.argv) > 1 and sys.argv[1] == "patcher":
			with open("database.json", "r", encoding="utf-8") as f:
				data = json.load(f)
			f.close()
			for x in range(len(data["players"])):
				if ("name" not in data["players"][x].keys()):
					data["players"][x]["name"] = None
				if (data["players"][x]["name"] == None):
					user = await client.fetch_profile(data["players"][x]["id"])
					data["players"][x]["name"] = user.display_name
			with open("database.json", "w", encoding="utf-8") as f:
				json.dump(data, f)
			f.close()
		else:
			print("Ready to connect to EPIC servers, terminating in 5 seconds.")
			sleep(5)
		await client.close()

try:
	client = MyClient()
	client.run()
except:
	if not validLogin:
		try: os.remove("device_auths.json")
		except: pass